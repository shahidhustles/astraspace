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
  BROWSER_WORK_KIND_OBSERVE,
  type BrowserObserveResultPayload,
  type BrowserObserveState,
  type BrowserWorkRequest,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";

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

type ObserveContext = { observe: () => Promise<ObservationResult> };

function isObserveWorkRequest(request: BrowserWorkRequest): boolean {
  return request.kind === BROWSER_WORK_KIND_OBSERVE;
}

// Executes one brokered browser request against the service-worker-owned
// BrowserContext. Observation failures become a completed result whose payload
// carries the typed observation error; transport failures stay out of here.
export async function dispatchBrowserWorkRequest(
  request: BrowserWorkRequest,
  context: ObserveContext,
): Promise<BrowserWorkResult> {
  if (!isObserveWorkRequest(request)) {
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      status: "failed",
      error: {
        code: "malformed_envelope",
        message: `Unknown browser work kind: ${request.kind}`,
      },
      completedAt: new Date().toISOString(),
    };
  }

  const payload = await observePayload(context);
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    payload: payload as Record<string, unknown>,
    completedAt: new Date().toISOString(),
  };
}

async function observePayload(context: ObserveContext): Promise<BrowserObserveResultPayload> {
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
