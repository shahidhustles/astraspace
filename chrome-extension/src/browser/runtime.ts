import { resolveActionTabId, type BrowserActionRuntime } from "./actions/dispatcher";
import {
  BROWSER_ACTION_CANCEL_MESSAGE,
  BROWSER_ACTION_MESSAGE,
  type BrowserActionCancelReply,
  type BrowserActionRequest,
  type BrowserActionResult,
  type ScheduledAction,
} from "./actions/types";
import { parseBrowserActionMessage, parseBrowserCancelMessage } from "./actions/validation";
import { readJpegDimensions } from "./observation/capture";
import type { AttachResult } from "./page";
import type { BrowserState, ObservationResult } from "./types";
import { enqueueActionRequest, TabActionCoordinator } from "./waits/coordinator";
import type { ActionId } from "./waits/types";
import {
  BROWSER_WORK_KIND_ACTION,
  BROWSER_WORK_KIND_ACTION_CANCEL,
  BROWSER_WORK_KIND_OBSERVE,
  isBrowserActionCancelWorkPayload,
  isBrowserActionWorkPayload,
  isReadOnlyBrowserAction,
  type BrowserActionCancelWorkResultPayload,
  type BrowserActionEvidence,
  type BrowserActionOutcome,
  type BrowserActionWorkResultPayload,
  type BrowserObserveResultPayload,
  type BrowserObserveState,
  type BrowserWorkRequest,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";
import type { BrowserMutationLedger } from "./bridge-ledger";

export const ATTACH_ACTIVE_TAB_MESSAGE = "browser.attach-active-tab";
export const OBSERVE_SELECTED_TAB_MESSAGE = "browser.observe-selected-tab";

export interface BrowserRuntime extends BrowserActionRuntime {
  useActiveTab: () => Promise<AttachResult>;
  observe: () => Promise<ObservationResult>;
  scheduleAction: (input: { request: BrowserActionRequest; tabId: number }) => ScheduledAction;
  cancelAction: (id: ActionId) => BrowserActionCancelReply;
}

export function isAttachActiveTabMessage(message: unknown): message is { type: typeof ATTACH_ACTIVE_TAB_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === ATTACH_ACTIVE_TAB_MESSAGE
  );
}

export function isObserveSelectedTabMessage(
  message: unknown,
): message is { type: typeof OBSERVE_SELECTED_TAB_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === OBSERVE_SELECTED_TAB_MESSAGE
  );
}

export function isBrowserActionMessage(message: unknown): message is { type: typeof BROWSER_ACTION_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === BROWSER_ACTION_MESSAGE
  );
}

export function isBrowserActionCancelMessage(message: unknown): message is { type: typeof BROWSER_ACTION_CANCEL_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === BROWSER_ACTION_CANCEL_MESSAGE
  );
}

export async function handleBrowserRuntimeMessage(
  message: unknown,
  runtime: BrowserRuntime,
): Promise<AttachResult | ObservationResult | BrowserActionResult | BrowserActionCancelReply | null> {
  if (isAttachActiveTabMessage(message)) {
    return runtime.useActiveTab();
  }
  if (isObserveSelectedTabMessage(message)) {
    return runtime.observe();
  }
  if (isBrowserActionCancelMessage(message)) {
    const parsed = parseBrowserCancelMessage(message);
    if (!parsed.ok) {
      return { ok: false, actionId: null, error: parsed.error };
    }
    return runtime.cancelAction(parsed.actionId);
  }
  if (isBrowserActionMessage(message)) {
    const parsed = parseBrowserActionMessage(message);
    if (!parsed.ok) {
      return { ok: false, action: parsed.action, tabId: null, error: parsed.error };
    }
    const tabId = resolveActionTabId(parsed.request, runtime.selectedTabId);
    if (tabId === null) {
      return {
        ok: false,
        action: parsed.request.action,
        tabId: null,
        error: { code: "selected_tab_unavailable", message: "No selected live connection" },
      };
    }
    const scheduled = runtime.scheduleAction({ request: parsed.request, tabId });
    if (!scheduled.ok) {
      return { ok: false, action: scheduled.action, tabId, error: scheduled.error };
    }
    return scheduled.settled;
  }
  return null;
}

// Wraps a plain action runtime with per-tab action scheduling. Test fakes and
// embedders use this to get queueing and cancellation in one call.
export function attachTabActionCoordinator(
  base: Omit<BrowserRuntime, "scheduleAction" | "cancelAction">,
): BrowserRuntime {
  const coordinator = new TabActionCoordinator();
  return {
    ...base,
    scheduleAction: ({ request, tabId }) => enqueueActionRequest(coordinator, request, tabId, base),
    cancelAction: (id) => coordinator.cancel(id),
  };
}

type BrokerRuntime = BrowserRuntime;

function isObserveWorkRequest(request: BrowserWorkRequest): boolean {
  return request.kind === BROWSER_WORK_KIND_OBSERVE;
}

// Executes one brokered browser request against the service-worker-owned
// BrowserContext. Observation failures become a completed result whose payload
// carries the typed observation error; transport failures stay out of here.
export async function dispatchBrowserWorkRequest(
  request: BrowserWorkRequest,
  context: BrokerRuntime,
  ledger?: BrowserMutationLedger,
): Promise<BrowserWorkResult> {
  if (isObserveWorkRequest(request)) {
    return completedWorkResult(request, await observePayload(context));
  }
  if (request.kind === BROWSER_WORK_KIND_ACTION) {
    return dispatchActionWork(request, context, ledger);
  }
  if (request.kind === BROWSER_WORK_KIND_ACTION_CANCEL) {
    return dispatchCancelWork(request, context);
  }
  return failedWorkResult(request, "malformed_envelope", `Unknown browser work kind: ${request.kind}`);
}

async function dispatchActionWork(
  request: BrowserWorkRequest,
  context: BrokerRuntime,
  ledger: BrowserMutationLedger | undefined,
): Promise<BrowserWorkResult> {
  if (!isBrowserActionWorkPayload(request.payload)) {
    return failedWorkResult(request, "malformed_envelope", "Browser action payload is not valid");
  }
  const payload = request.payload;
  const actionId = payload.actionId;
  if (actionId === null) {
    return failedWorkResult(request, "malformed_envelope", "Browser action payload needs an action id");
  }
  const mutating = !isReadOnlyBrowserAction(payload.action);
  if (mutating && ledger !== undefined) {
    const prior = await ledger.begin(actionId);
    if (prior !== "dispatch") {
      if (prior === "uncertain") {
        return failedWorkResult(
          request,
          "action_replay_uncertain",
          "This action was dispatched before the worker restarted. Observe before deciding what changed.",
        );
      }
      return { ...prior, requestId: request.requestId, sessionId: request.sessionId };
    }
  }

  const runtimeResult = await handleBrowserRuntimeMessage(
    {
      type: BROWSER_ACTION_MESSAGE,
      action: payload.action,
      input: payload.input,
      actionId,
      wait: actionWaitToRuntime(payload.wait),
    },
    context,
  );
  if (runtimeResult === null || !("action" in runtimeResult)) {
    const failed = failedWorkResult(request, "broker_unavailable", "Browser action returned no result");
    if (mutating && ledger !== undefined) await ledger.settle(actionId, failed);
    return failed;
  }

  const action = actionOutcomeToWire(runtimeResult);
  let observation: BrowserObserveState | null = null;
  let observationError: { code: string; message: string } | null = null;
  if (mutating && actionDispatched(runtimeResult)) {
    const observed = await observePayload(context);
    if (observed.ok) observation = observed.state;
    else observationError = { code: "post_action_observation_failed", message: observed.error.message };
  }
  const resultPayload: BrowserActionWorkResultPayload = { action, observation, observationError };
  const completed = completedWorkResult(request, resultPayload);
  if (mutating && ledger !== undefined) {
    await ledger.settle(
      actionId,
      completedWorkResult(request, {
        action,
        observation: null,
        observationError: {
          code: "replayed_action_result_requires_observation",
          message: "This recorded action result was replayed. Observe before deciding what the page contains.",
        },
      }),
    );
  }
  return completed;
}

function actionWaitToRuntime(
  wait: import("@astra-space/browser-control-contract").BrowserActionWait | null,
): Record<string, unknown> | undefined {
  if (wait === null) return undefined;
  const runtimeWait: Record<string, unknown> = {};
  if (wait.timeoutMs !== null) runtimeWait.timeoutMs = wait.timeoutMs;
  if (wait.expectation !== null) runtimeWait.expectation = wait.expectation;
  return Object.keys(runtimeWait).length > 0 ? runtimeWait : undefined;
}

async function dispatchCancelWork(
  request: BrowserWorkRequest,
  context: BrokerRuntime,
): Promise<BrowserWorkResult> {
  if (!isBrowserActionCancelWorkPayload(request.payload)) {
    return failedWorkResult(request, "malformed_envelope", "Browser action cancellation payload is not valid");
  }
  const reply = await handleBrowserRuntimeMessage(
    { type: BROWSER_ACTION_CANCEL_MESSAGE, actionId: request.payload.actionId },
    context,
  );
  if (reply === null || !("actionId" in reply) || "action" in reply) {
    return failedWorkResult(request, "broker_unavailable", "Browser cancellation returned no result");
  }
  const payload: BrowserActionCancelWorkResultPayload = reply.ok
    ? {
        ok: true,
        actionId: reply.actionId,
        cancelled: reply.cancelled,
        dispatchStarted: reply.dispatchStarted,
      }
    : {
        ok: false,
        actionId: reply.actionId,
        error: { code: reply.error.code, message: reply.error.message },
      };
  return completedWorkResult(request, payload);
}

function actionDispatched(result: BrowserActionResult): boolean {
  return result.ok || result.completion?.dispatchStarted === true;
}

function actionOutcomeToWire(result: BrowserActionResult): BrowserActionOutcome {
  const evidence = completionToWire(result.completion);
  if (result.ok) {
    return {
      ok: true,
      action: result.action,
      tabId: result.tabId,
      url: result.url,
      snapshotInvalidated: result.snapshotInvalidated,
      data: { ...result.data },
      ...(evidence ? { evidence } : {}),
    };
  }
  const target = "target" in result.error ? { ...result.error.target } : undefined;
  const dispatchStarted = "dispatchStarted" in result.error ? result.error.dispatchStarted : undefined;
  return {
    ok: false,
    action: result.action,
    tabId: result.tabId,
    error: {
      code: result.error.code,
      message: result.error.message,
      ...(target ? { target } : {}),
      ...(dispatchStarted !== undefined ? { dispatchStarted } : {}),
    },
    ...(evidence ? { evidence } : {}),
  };
}

function completionToWire(
  completion: BrowserActionResult["completion"],
): BrowserActionEvidence | undefined {
  if (completion === undefined) return undefined;
  return {
    actionId: completion.actionId,
    status: completion.status,
    elapsedMs: completion.elapsedMs,
    dispatchStarted: completion.dispatchStarted,
  };
}

function completedWorkResult(
  request: BrowserWorkRequest,
  payload: Record<string, unknown> | BrowserObserveResultPayload | BrowserActionWorkResultPayload | BrowserActionCancelWorkResultPayload,
): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    payload: { ...payload },
    completedAt: new Date().toISOString(),
  };
}

function failedWorkResult(
  request: BrowserWorkRequest,
  code: "malformed_envelope" | "broker_unavailable" | "action_replay_uncertain",
  message: string,
): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "failed",
    error: { code, message },
    completedAt: new Date().toISOString(),
  };
}

async function observePayload(context: { observe: () => Promise<ObservationResult> }): Promise<BrowserObserveResultPayload> {
  const result = await context.observe();
  if (!result.ok) {
    return { ok: false, error: { code: result.error.code, message: result.error.message } };
  }

  const state = result.state;
  if (!screenshotMatchesSnapshot(state)) {
    return {
      ok: false,
      error: {
        code: "observation_failed",
        message: "The captured screenshot does not match the observation's snapshot identity",
      },
    };
  }
  return { ok: true, state: observeStateToWire(state) };
}

function screenshotMatchesSnapshot(state: BrowserState): boolean {
  const dimensions = readJpegDimensions(state.screenshot.data);
  if (dimensions === null) return false;
  return dimensions.width === state.screenshot.width && dimensions.height === state.screenshot.height;
}

function observeStateToWire(state: BrowserState): BrowserObserveState {
  return {
    tabs: state.tabs.map((tab) => ({
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      attached: tab.attached,
      selected: tab.selected,
    })),
    tabId: state.tabId,
    url: state.url,
    title: state.title,
    scroll: { ...state.scroll },
    snapshot: {
      snapshotId: state.snapshotId,
      snapshotVersion: state.snapshotVersion,
      documentEpoch: state.documentEpoch,
      navigationEpoch: state.navigationEpoch,
    },
    refs: state.refs.map((ref) => ({
      ref: ref.ref,
      tag: ref.tag,
      role: ref.role,
      name: ref.name,
      attrs: { ...ref.attrs },
      bounds: ref.bounds ? { ...ref.bounds } : null,
    })),
    dom: state.dom,
    screenshot: {
      mimeType: "image/jpeg",
      data: state.screenshot.data,
      width: state.screenshot.width,
      height: state.screenshot.height,
    },
  };
}
