import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_WORK_KIND_ACTION,
  BROWSER_WORK_KIND_ACTION_CANCEL,
  BROWSER_WORK_KIND_OBSERVE,
  type BrowserActionWorkResultPayload,
  type BrowserControlErrorCode,
  type BrowserObserveState,
  type BrowserWorkRequest,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";
import { BrowserBroker } from "../agent/lib/browser-broker";
import { observeSelectedPage, runBrowserAction } from "../agent/lib/browser-control";

const JPEG_STUB = "/9j/fixture-jpeg-base64";

interface Harness {
  broker: BrowserBroker;
  root: string;
  token: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness === undefined) continue;
    await harness.broker.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "astra-eve-loop-test-"));
  const broker = new BrowserBroker({
    root,
    sweep: false,
    timings: { pollIntervalMs: 5, leaseMs: 10_000 },
  });
  harnesses.push({ broker, root, token: "" });
  const harness = harnesses[harnesses.length - 1];
  if (harness === undefined) throw new Error("unreachable");
  const bind = await broker.bind("session-1");
  harness.token = bind.connectionToken;
  return harness;
}

async function lease(broker: BrowserBroker, token: string): Promise<BrowserWorkRequest> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const request = (await broker.lease(token, 20)).requests[0];
    if (request) return request;
  }
  throw new Error("request was not leased");
}

function completed(request: BrowserWorkRequest, payload: BrowserActionWorkResultPayload): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    payload: payload as unknown as Record<string, unknown>,
    completedAt: new Date().toISOString(),
  };
}

function failed(request: BrowserWorkRequest, code: BrowserControlErrorCode, message: string): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "failed",
    error: { code, message },
    completedAt: new Date().toISOString(),
  };
}

function actionCtx(overrides: Partial<{ callId: string; abortSignal: AbortSignal }> = {}) {
  return {
    session: { id: "session-1", turn: { id: "turn-1" } },
    callId: "call-1",
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function timedOutAction(request: BrowserWorkRequest): BrowserWorkResult {
  return completed(request, {
    action: {
      ok: true,
      action: "browser_type",
      tabId: 7,
      url: "http://127.0.0.1:9/eve-loop",
      snapshotInvalidated: true,
      data: { kind: "type" },
      evidence: {
        actionId: request.callId,
        status: "timed_out",
        elapsedMs: 4000,
        dispatchStarted: true,
      },
    },
    observation: null,
    observationError: null,
  });
}

function observePayload(dom: string): BrowserObserveState {
  return {
    tabs: [
      { tabId: 7, url: "http://127.0.0.1:9/eve-loop", title: "Fixture", attached: true, selected: true },
    ],
    tabId: 7,
    url: "http://127.0.0.1:9/eve-loop",
    title: "Fixture",
    scroll: { x: 0, y: 0, maxX: 0, maxY: 400, atTop: true, atBottom: false, atLeft: true, atRight: true },
    snapshot: { snapshotId: "snapshot-2", snapshotVersion: 1, documentEpoch: 1, navigationEpoch: 1 },
    refs: [],
    dom,
    screenshot: { mimeType: "image/jpeg", data: JPEG_STUB, width: 4, height: 4 },
  };
}

function observeResult(request: BrowserWorkRequest, dom: string): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    payload: {
      ok: true,
      state: observePayload(dom),
    },
    completedAt: new Date().toISOString(),
  };
}

// After a request settles, the broker unlinks its pending and lease files so
// nothing can be re-dispatched. The terminal result file stays until the
// retention sweep removes it; that is what replay dedupe reads.
async function expectNoResidualFiles(root: string, requestIds: string[]) {
  for (const dir of ["pending", "leases"]) {
    const entries = await readdir(join(root, dir)).catch(() => []);
    for (const requestId of requestIds) {
      expect(entries).not.toContain(`${requestId}.json`);
    }
  }
  const results = await readdir(join(root, "results")).catch(() => []);
  for (const requestId of requestIds) {
    expect(results).toContain(`${requestId}.json`);
  }
}

describe("the eve browser loop recovers from lifecycle failures", () => {
  test("a post-dispatch timeout returns truthful timed_out state and leaves no residual files", async () => {
    const { broker, token, root } = await createHarness();
    const actionPromise = runBrowserAction({
      action: "browser_type",
      input: { target: { tabId: 7, snapshotId: "snapshot-1", ref: 1 }, text: "astra" },
      wait: { timeoutMs: 5_000, expectation: null },
      ctx: actionCtx(),
      broker,
    });
    const request = await lease(broker, token);
    await broker.submitResult(token, timedOutAction(request));

    const output = await actionPromise;
    expect(output.ok).toBe(true);
    expect(output.action.ok).toBe(true);
    if (!output.action.ok) throw new Error("unreachable");
    expect(output.action.evidence).toMatchObject({
      status: "timed_out",
      dispatchStarted: true,
    });
    expect(output.action.data.kind).toBe("type");
    await expectNoResidualFiles(root, [request.requestId]);
  });

  test("cancelling a dispatched action enqueues the mapped browser cancel and leaves the session clean", async () => {
    const { broker, token, root } = await createHarness();
    const controller = new AbortController();
    const actionPromise = runBrowserAction({
      action: "browser_refresh",
      input: {},
      ctx: actionCtx({ abortSignal: controller.signal }),
      broker,
    });
    const action = await lease(broker, token);
    expect(action.kind).toBe(BROWSER_WORK_KIND_ACTION);
    expect(action.payload.actionId).toBe("call-1");

    controller.abort();
    await expect(actionPromise).rejects.toThrow("cancelled");

    const cancel = await lease(broker, token);
    expect(cancel.kind).toBe(BROWSER_WORK_KIND_ACTION_CANCEL);
    expect(cancel.payload).toEqual({ actionId: "call-1" });
    await expectNoResidualFiles(root, [action.requestId]);

    // The same session accepts a fresh observation after the cancellation.
    const observePromise = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-2",
      callId: "call-2",
      abortSignal: new AbortController().signal,
    });
    const observe = await lease(broker, token);
    expect(observe.kind).toBe(BROWSER_WORK_KIND_OBSERVE);
    await broker.submitResult(token, observeResult(observe, "<main>clean</main>"));
    const output = await observePromise;
    expect(output.ok).toBe(true);
    expect(output.observation.dom).toContain("clean");
  });

  test("an uncertain replay never re-dispatches the mutation", async () => {
    const { broker, token, root } = await createHarness();
    const ctx = actionCtx({ callId: "stable-eve-call-id" });

    const firstAttempt = runBrowserAction({ action: "browser_refresh", input: {}, ctx, broker });
    const first = await lease(broker, token);
    await broker.submitResult(token, failed(first, "action_replay_uncertain", "fixture interrupted after dispatch"));
    await expect(firstAttempt).rejects.toThrow("action_replay_uncertain");

    const rerun = runBrowserAction({ action: "browser_refresh", input: {}, ctx, broker });
    const second = await lease(broker, token);
    await broker.submitResult(token, failed(second, "action_replay_uncertain", "fixture interrupted after dispatch"));
    await expect(rerun).rejects.toThrow("action_replay_uncertain");

    // The same call id maps to the same action id: the extension ledger can
    // answer a replay with the recorded result instead of dispatching twice.
    expect(first.payload.actionId).toBe("stable-eve-call-id");
    expect(second.payload.actionId).toBe("stable-eve-call-id");
    await expectNoResidualFiles(root, [first.requestId, second.requestId]);
  });

  test("a lease expiry settles bounded and a rebind restores the same session", async () => {
    const { broker, token, root } = await createHarness();
    const observePromise = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      abortSignal: new AbortController().signal,
      resultTimeoutMs: 60,
    });
    const request = await lease(broker, token);
    // The extension side never answers; the tool's deadline cancels the request.
    await expect(observePromise).rejects.toThrow("lease_expired");
    await expectNoResidualFiles(root, [request.requestId]);

    // Rebind with a fresh token and the same session works again.
    const rebind = await broker.bind("session-1");
    const observe2 = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-2",
      callId: "call-2",
      abortSignal: new AbortController().signal,
    });
    const request2 = await lease(broker, rebind.connectionToken);
    expect(request2.kind).toBe(BROWSER_WORK_KIND_OBSERVE);
    await broker.submitResult(rebind.connectionToken, observeResult(request2, "<main>back</main>"));
    const output = await observe2;
    expect(output.ok).toBe(true);
    expect(output.observation.dom).toContain("back");
  });

  test("detach and tab-close failures are typed and a later run succeeds", async () => {
    const { broker, token, root } = await createHarness();

    const detach = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      abortSignal: new AbortController().signal,
    });
    const detachRequest = await lease(broker, token);
    await broker.submitResult(
      token,
      failed(detachRequest, "browser_unavailable", "the controlled tab is gone"),
    );
    await expect(detach).rejects.toThrow("browser_unavailable");
    await expectNoResidualFiles(root, [detachRequest.requestId]);

    const unavailable = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-2",
      callId: "call-2",
      abortSignal: new AbortController().signal,
    });
    const unavailableRequest = await lease(broker, token);
    await broker.submitResult(
      token,
      failed(unavailableRequest, "browser_unavailable", "no extension connection"),
    );
    await expect(unavailable).rejects.toThrow("browser_unavailable");

    // Same session, same token: the next request completes normally.
    const after = observeSelectedPage({
      broker,
      sessionId: "session-1",
      turnId: "turn-3",
      callId: "call-3",
      abortSignal: new AbortController().signal,
    });
    const afterRequest = await lease(broker, token);
    await broker.submitResult(token, observeResult(afterRequest, "<main>recovered</main>"));
    const output = await after;
    expect(output.ok).toBe(true);
    expect(output.observation.dom).toContain("recovered");
  });
});
