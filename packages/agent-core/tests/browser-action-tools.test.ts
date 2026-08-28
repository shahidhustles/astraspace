import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_WORK_KIND_ACTION,
  BROWSER_WORK_KIND_ACTION_CANCEL,
  type BrowserActionWorkResultPayload,
  type BrowserWorkRequest,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";
import { BrowserBroker } from "../agent/lib/browser-broker";
import { browserActionModelParts, runBrowserAction } from "../agent/lib/browser-control";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "astra-action-tool-"));
  roots.push(root);
  const broker = new BrowserBroker({ root, sweep: false, timings: { pollIntervalMs: 5, leaseMs: 10_000 } });
  const bind = await broker.bind("session-1");
  return { broker, token: bind.connectionToken };
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
    payload: { ...payload },
    completedAt: new Date().toISOString(),
  };
}

const ctx = {
  session: { id: "session-1", turn: { id: "turn-1" } },
  callId: "call-1",
  abortSignal: new AbortController().signal,
};

describe("runBrowserAction", () => {
  test("maps the Eve call id and returns action evidence with a fresh observation", async () => {
    const { broker, token } = await harness();
    const actionPromise = runBrowserAction({
      action: "browser_navigate",
      input: { url: "https://example.test" },
      wait: { timeoutMs: 2_000, expectation: null },
      ctx,
      broker,
    });
    const request = await lease(broker, token);
    expect(request.kind).toBe(BROWSER_WORK_KIND_ACTION);
    expect(request.callId).toBe("call-1");
    expect(request.payload).toMatchObject({ action: "browser_navigate", actionId: "call-1" });

    await broker.submitResult(token, completed(request, {
      action: {
        ok: true,
        action: "browser_navigate",
        tabId: 7,
        url: "https://example.test/",
        snapshotInvalidated: true,
        data: { kind: "navigate" },
        evidence: { actionId: "call-1", status: "completed", elapsedMs: 12, dispatchStarted: true },
      },
      observation: null,
      observationError: { code: "post_action_observation_failed", message: "fixture" },
    }));

    const output = await actionPromise;
    expect(output.action.ok).toBe(true);
    const text = browserActionModelParts(output)[0];
    expect(text?.type === "text" ? text.text : "").toContain("Observe again");
  });

  test("enqueues browser cancellation for the same action id", async () => {
    const { broker, token } = await harness();
    const controller = new AbortController();
    const actionPromise = runBrowserAction({
      action: "browser_refresh",
      input: {},
      ctx: { ...ctx, abortSignal: controller.signal },
      broker,
    });
    const action = await lease(broker, token);
    expect(action.kind).toBe(BROWSER_WORK_KIND_ACTION);
    controller.abort();
    await expect(actionPromise).rejects.toThrow("cancelled");
    const cancel = await lease(broker, token);
    expect(cancel.kind).toBe(BROWSER_WORK_KIND_ACTION_CANCEL);
    expect(cancel.payload).toEqual({ actionId: "call-1" });
  });
});
