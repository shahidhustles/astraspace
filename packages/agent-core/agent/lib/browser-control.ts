import {
  BROWSER_WORK_KIND_ACTION,
  BROWSER_WORK_KIND_ACTION_CANCEL,
  BROWSER_WORK_KIND_OBSERVE,
  type BrowserActionName,
  type BrowserActionWait,
  type BrowserActionWorkResultPayload,
  type BrowserControlErrorCode,
  type BrowserObserveRef,
  type BrowserObserveState,
  type BrowserObservationErrorCode,
  type BrowserWorkResult,
  isBrowserObserveResultPayload,
  isBrowserActionWorkResultPayload,
  jsonByteSize,
} from "@astra-space/browser-control-contract";
import type { ToolModelOutputPart } from "eve/tools";
import { toolOutputPart } from "eve/tools";
import { BrowserBroker, BrowserBrokerError } from "./browser-broker";

export const EVE_FILE_WARN_BYTES = 3 * 1024 * 1024;

const BIND_WAIT_MS = 10_000;
const RESULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;

export type BrowserObserveErrorCode =
  | BrowserControlErrorCode
  | BrowserObservationErrorCode
  | "cancelled";

export class BrowserObserveError extends Error {
  readonly code: BrowserObserveErrorCode;

  constructor(code: BrowserObserveErrorCode, message: string) {
    super(`browser_observe failed (${code}): ${message}`);
    this.code = code;
  }
}

export interface BrowserObserveOutput {
  ok: true;
  observation: BrowserObserveState;
  screenshot: { data: string; mediaType: "image/jpeg" };
}

export interface ObserveSelectedPageInput {
  broker: BrowserBroker;
  sessionId: string;
  turnId: string;
  callId: string;
  abortSignal?: AbortSignal;
  bindWaitMs?: number;
  resultTimeoutMs?: number;
}

export interface BrowserActionToolContext {
  session: { id: string; turn: { id: string } };
  callId: string;
  abortSignal: AbortSignal;
}

export interface BrowserActionToolInput {
  action: BrowserActionName;
  input: Record<string, unknown>;
  wait?: BrowserActionWait;
  ctx: BrowserActionToolContext;
  broker?: BrowserBroker;
}

export interface BrowserActionOutput extends BrowserActionWorkResultPayload {
  ok: true;
}

export async function runBrowserAction(input: BrowserActionToolInput): Promise<BrowserActionOutput> {
  const broker = input.broker ?? BrowserBroker.shared();
  if (!(await waitForSessionConnection(broker, input.ctx.session.id, BIND_WAIT_MS))) {
    throw new BrowserObserveError("browser_unavailable", "No extension is bound to this Eve session");
  }

  const request = await wrapBrokerFailure(() =>
    broker.enqueue(input.ctx.session.id, {
      sessionId: input.ctx.session.id,
      turnId: input.ctx.session.turn.id,
      callId: input.ctx.callId,
      kind: BROWSER_WORK_KIND_ACTION,
      payload: {
        action: input.action,
        input: input.input,
        actionId: input.ctx.callId,
        wait: input.wait ?? null,
      },
    }),
  );

  const result = await raceAbort(
    () => wrapBrokerFailure(() => broker.waitForResult(input.ctx.session.id, request.requestId, RESULT_TIMEOUT_MS)),
    input.ctx.abortSignal,
    async () => {
      await broker.enqueue(input.ctx.session.id, {
        sessionId: input.ctx.session.id,
        turnId: input.ctx.session.turn.id,
        callId: `${input.ctx.callId}:cancel`,
        kind: BROWSER_WORK_KIND_ACTION_CANCEL,
        payload: { actionId: input.ctx.callId },
      });
      await broker.cancel(input.ctx.session.id, request.requestId);
    },
  );

  if (result.status === "cancelled") throw cancelledError();
  if (result.status === "failed") {
    throw new BrowserObserveError(result.error.code, result.error.message);
  }
  if (!isBrowserActionWorkResultPayload(result.payload)) {
    throw new BrowserObserveError("malformed_envelope", "The browser action result did not match the protocol");
  }
  return { ok: true, ...result.payload };
}

export function browserActionModelParts(output: BrowserActionOutput): ToolModelOutputPart[] {
  const action = output.action;
  const evidence = action.evidence;
  const lines = [
    action.ok
      ? `${action.action} ${evidence?.status ?? "completed"} on tab ${action.tabId} at ${action.url}`
      : `${action.action ?? "browser action"} failed (${action.error.code}): ${action.error.message}`,
    evidence
      ? `Dispatch started: ${evidence.dispatchStarted}; elapsed: ${evidence.elapsedMs}ms; actionId: ${evidence.actionId ?? "none"}`
      : null,
    output.observationError
      ? `Post-action observation failed (${output.observationError.code}): ${output.observationError.message}. Observe again before deciding what changed.`
      : null,
  ].filter((line): line is string => line !== null);

  if (output.observation === null) return [toolOutputPart.text(lines.join("\n"))];
  const observeParts = browserObserveModelParts({
    ok: true,
    observation: output.observation,
    screenshot: { data: output.observation.screenshot.data, mediaType: "image/jpeg" },
  });
  return [toolOutputPart.text(lines.join("\n")), ...observeParts];
}

export async function observeSelectedPage(
  input: ObserveSelectedPageInput,
): Promise<BrowserObserveOutput> {
  const bindWaitMs = input.bindWaitMs ?? BIND_WAIT_MS;
  if (!(await waitForSessionConnection(input.broker, input.sessionId, bindWaitMs))) {
    throw new BrowserObserveError(
      "browser_unavailable",
      "No extension is bound to this Eve session",
    );
  }

  const request = await wrapBrokerFailure(() =>
    input.broker.enqueue(input.sessionId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      callId: input.callId,
      kind: BROWSER_WORK_KIND_OBSERVE,
      payload: {},
    }),
  );

  const result = await raceAbort(
    () =>
      wrapBrokerFailure(() =>
        input.broker.waitForResult(input.sessionId, request.requestId, input.resultTimeoutMs ?? RESULT_TIMEOUT_MS),
      ),
    input.abortSignal,
    () => input.broker.cancel(input.sessionId, request.requestId),
  );

  return decodeObserveResult(result);
}

export function browserObserveModelParts(output: BrowserObserveOutput): ToolModelOutputPart[] {
  const state = output.observation;
  const text = [
    `Selected tab ${state.tabId}: ${state.title} (${state.url})`,
    `Tabs: ${state.tabs
      .map((tab) => {
        const marks = [tab.selected ? "selected" : null, tab.attached ? "attached" : null]
          .filter((mark) => mark !== null)
          .join(", ");
        return `${tab.tabId}${marks.length > 0 ? ` [${marks}]` : ""}: ${tab.title} (${tab.url})`;
      })
      .join("; ")}`,
    `Scroll: x=${state.scroll.x} y=${state.scroll.y} maxX=${state.scroll.maxX} maxY=${state.scroll.maxY} (atTop=${state.scroll.atTop}, atBottom=${state.scroll.atBottom}, atLeft=${state.scroll.atLeft}, atRight=${state.scroll.atRight})`,
    `Snapshot: ${state.snapshot.snapshotId} version=${state.snapshot.snapshotVersion} documentEpoch=${state.snapshot.documentEpoch} navigationEpoch=${state.snapshot.navigationEpoch}`,
    `Refs: ${state.refs.map((ref) => renderRef(ref)).join("; ")}`,
    `DOM:\n${state.dom}`,
  ].join("\n\n");
  return [
    toolOutputPart.text(text),
    toolOutputPart.file(output.screenshot.data, {
      mediaType: "image/jpeg",
      filename: `tab-${state.tabId}-snapshot.jpeg`,
    }),
  ];
}

function renderRef(ref: BrowserObserveRef): string {
  const label = ref.name ?? "";
  const role = ref.role ?? ref.tag;
  const bounds = ref.bounds
    ? ` @${Math.round(ref.bounds.x)},${Math.round(ref.bounds.y)} ${Math.round(ref.bounds.width)}x${Math.round(ref.bounds.height)}`
    : "";
  const attrs = Object.entries(ref.attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return `${ref.ref} [${role}]${label.length > 0 ? ` ${JSON.stringify(label)}` : ""}${bounds}${attrs.length > 0 ? ` ${attrs}` : ""}`;
}

async function waitForSessionConnection(
  broker: BrowserBroker,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (await broker.hasConnectionForSession(sessionId)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function raceAbort<T>(
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<unknown>,
): Promise<T> {
  if (signal === undefined) return run();
  if (signal.aborted) {
    await onAbort();
    throw cancelledError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbortListener = () => {
      void onAbort()
        .catch(() => {})
        .finally(() => reject(cancelledError()));
    };
    signal.addEventListener("abort", onAbortListener, { once: true });
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbortListener));
  });
}

async function wrapBrokerFailure<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BrowserBrokerError) {
      throw new BrowserObserveError(error.code, error.message);
    }
    throw error;
  }
}

function decodeObserveResult(result: BrowserWorkResult): BrowserObserveOutput {
  if (result.status === "cancelled") {
    throw new BrowserObserveError("cancelled", "The browser observation was cancelled");
  }
  if (result.status === "failed") {
    throw new BrowserObserveError(result.error.code, result.error.message);
  }
  if (!isBrowserObserveResultPayload(result.payload)) {
    throw new BrowserObserveError(
      "malformed_envelope",
      "The browser observation result did not match the protocol",
    );
  }
  if (!result.payload.ok) {
    throw new BrowserObserveError(result.payload.error.code, result.payload.error.message);
  }

  const state = result.payload.state;
  assertScreenshotMatchesSnapshot(state);
  assertOutputSizeWithinGuideline(state);
  return { ok: true, observation: state, screenshot: { data: state.screenshot.data, mediaType: "image/jpeg" } };
}

function assertScreenshotMatchesSnapshot(state: BrowserObserveState): void {
  const screenshot = state.screenshot;
  if (!screenshot.data.startsWith("/9j/")) {
    throw new BrowserObserveError(
      "observation_failed",
      "The observation screenshot is not a JPEG, so it cannot match the snapshot identity",
    );
  }
  if (screenshot.width <= 0 || screenshot.height <= 0) {
    throw new BrowserObserveError(
      "observation_failed",
      "The observation screenshot has no dimensions, so it cannot match the snapshot identity",
    );
  }
}

function assertOutputSizeWithinGuideline(state: BrowserObserveState): void {
  const base64Bytes = state.screenshot.data.length;
  const textBytes = jsonByteSize({
    tabs: state.tabs,
    tabId: state.tabId,
    url: state.url,
    title: state.title,
    scroll: state.scroll,
    snapshot: state.snapshot,
    refs: state.refs,
    dom: state.dom,
  });
  if (textBytes === null) {
    throw new BrowserObserveError(
      "malformed_envelope",
      "The browser observation contains values that are not JSON-safe",
    );
  }
  if (base64Bytes + textBytes > EVE_FILE_WARN_BYTES) {
    throw new BrowserObserveError(
      "payload_too_large",
      `The browser observation exceeds the ${EVE_FILE_WARN_BYTES} byte tool output guideline`,
    );
  }
}

function cancelledError(): BrowserObserveError {
  return new BrowserObserveError("cancelled", "The turn was cancelled before the observation completed");
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
