import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWorkRequest, BrowserWorkResult } from "@astra-space/browser-control-contract";
import { BrowserBroker } from "../agent/lib/browser-broker";
import { runBrowserAction } from "../agent/lib/browser-control";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function createBroker() {
  const root = await mkdtemp(join(tmpdir(), "astra-call-id-retry-"));
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

function failed(request: BrowserWorkRequest): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "failed",
    error: { code: "action_replay_uncertain", message: "fixture interrupted after dispatch" },
    completedAt: new Date().toISOString(),
  };
}

describe("Eve call id mapping across an interrupted action rerun", () => {
  test("maps the same ctx.callId to the same browser action id on both attempts", async () => {
    const { broker, token } = await createBroker();
    const ctx = {
      session: { id: "session-1", turn: { id: "turn-1" } },
      callId: "stable-eve-call-id",
      abortSignal: new AbortController().signal,
    };

    const firstAttempt = runBrowserAction({ action: "browser_refresh", input: {}, ctx, broker });
    const first = await lease(broker, token);
    await broker.submitResult(token, failed(first));
    await expect(firstAttempt).rejects.toThrow("action_replay_uncertain");

    const rerun = runBrowserAction({ action: "browser_refresh", input: {}, ctx, broker });
    const second = await lease(broker, token);
    await broker.submitResult(token, failed(second));
    await expect(rerun).rejects.toThrow("action_replay_uncertain");

    expect(first.callId).toBe("stable-eve-call-id");
    expect(second.callId).toBe(first.callId);
    expect(first.payload.actionId).toBe("stable-eve-call-id");
    expect(second.payload.actionId).toBe(first.payload.actionId);
  });
});
