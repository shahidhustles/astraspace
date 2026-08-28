import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_WORK_KIND_ACTION,
  BROWSER_WORK_KIND_ACTION_CANCEL,
  BROWSER_WORK_KIND_OBSERVE,
  type BrowserObserveState,
  type BrowserWorkRequest,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";
import { BrowserBroker } from "../agent/lib/browser-broker";
import {
  BrowserObserveError,
  browserObserveModelParts,
  observeSelectedPage,
  runBrowserAction,
} from "../agent/lib/browser-control";

const JPEG_STUB = "/9j/fixture-jpeg-base64";
const SESSION_ID = "session-1";

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
  const root = await mkdtemp(join(tmpdir(), "astra-browser-control-test-"));
  const broker = new BrowserBroker({
    root,
    sweep: false,
    timings: { pollIntervalMs: 5, leaseMs: 10_000 },
  });
  harnesses.push({ broker, root, token: "" });
  const harness = harnesses[harnesses.length - 1];
  if (!harness) throw new Error("unreachable");
  const bind = await broker.bind(SESSION_ID);
  harness.token = bind.connectionToken;
  return harness;
}

function observeState(overrides: Partial<BrowserObserveState> = {}): BrowserObserveState {
  return {
    tabs: [
      { tabId: 7, url: "http://127.0.0.1:9/fixture", title: "Fixture", attached: true, selected: true },
    ],
    tabId: 7,
    url: "http://127.0.0.1:9/fixture",
    title: "Fixture",
    scroll: { x: 0, y: 0, maxX: 0, maxY: 400, atTop: true, atBottom: false, atLeft: true, atRight: true },
    snapshot: { snapshotId: "snapshot-1", snapshotVersion: 3, documentEpoch: 1, navigationEpoch: 1 },
    refs: [
      {
        ref: 1,
        tag: "button",
        role: "button",
        name: "Submit",
        attrs: { type: "submit" },
        bounds: { x: 10, y: 20, width: 80, height: 24 },
      },
    ],
    dom: "[1]<button type=submit>Submit />",
    screenshot: { mimeType: "image/jpeg", data: JPEG_STUB, width: 4, height: 4 },
    ...overrides,
  };
}

function completedResult(request: BrowserWorkRequest, payload: unknown): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "completed",
    payload: payload as Record<string, unknown>,
    completedAt: new Date().toISOString(),
  };
}

async function serveOneRequest(
  harness: Harness,
  respond: (request: BrowserWorkRequest) => Promise<BrowserWorkResult> | BrowserWorkResult,
): Promise<BrowserWorkRequest> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const lease = await harness.broker.lease(harness.token, 100);
    const request = lease.requests[0];
    if (request !== undefined) {
      await harness.broker.submitResult(harness.token, await respond(request));
      return request;
    }
  }
  throw new Error("no request was leased before the deadline");
}

function observe(harness: Harness, overrides: { abortSignal?: AbortSignal } = {}) {
  return observeSelectedPage({
    broker: harness.broker,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    callId: "call-1",
    bindWaitMs: 1_000,
    resultTimeoutMs: 5_000,
    ...overrides,
  });
}

describe("observeSelectedPage", () => {
  test("returns one synchronized observation and threads the eve identifiers", async () => {
    const harness = await createHarness();
    const [output, leased] = await Promise.all([
      observe(harness),
      serveOneRequest(harness, (request) => completedResult(request, { ok: true, state: observeState() })),
    ]);

    expect(leased.sessionId).toBe(SESSION_ID);
    expect(leased.turnId).toBe("turn-1");
    expect(leased.callId).toBe("call-1");
    expect(leased.kind).toBe(BROWSER_WORK_KIND_OBSERVE);

    expect(output.ok).toBe(true);
    expect(output.observation).toEqual(observeState());
    expect(output.screenshot).toEqual({ data: JPEG_STUB, mediaType: "image/jpeg" });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });

  test("model parts keep the base64 out of the text part", async () => {
    const harness = await createHarness();
    const [output] = await Promise.all([
      observe(harness),
      serveOneRequest(harness, (request) => completedResult(request, { ok: true, state: observeState() })),
    ]);

    const parts = browserObserveModelParts(output);
    expect(parts).toHaveLength(2);
    const [textPart, filePart] = parts;
    expect(textPart?.type).toBe("text");
    expect(filePart?.type).toBe("file");
    const text = textPart && textPart.type === "text" ? textPart.text : "";
    expect(text).toContain("[1]<button type=submit>Submit />");
    expect(text).toContain("snapshot-1");
    expect(text).toContain("Fixture");
    expect(text).not.toContain(JPEG_STUB);
    expect(filePart).toMatchObject({
      type: "file",
      mediaType: "image/jpeg",
      data: { type: "data", data: JPEG_STUB },
    });
  });

  test("rejects a screenshot that cannot match the snapshot identity", async () => {
    const harness = await createHarness();
    const notJpeg = observeState({ screenshot: { mimeType: "image/jpeg", data: "bm90LWEtanBlZw==", width: 4, height: 4 } });
    await expect(
      Promise.all([
        observe(harness),
        serveOneRequest(harness, (request) => completedResult(request, { ok: true, state: notJpeg })),
      ]),
    ).rejects.toMatchObject({ code: "observation_failed" });
  });

  test("propagates a typed observation failure", async () => {
    const harness = await createHarness();
    await expect(
      Promise.all([
        observe(harness),
        serveOneRequest(harness, (request) =>
          completedResult(request, {
            ok: false,
            error: { code: "selected_tab_unavailable", message: "No selected live connection" },
          }),
        ),
      ]),
    ).rejects.toMatchObject({
      code: "selected_tab_unavailable",
      message: expect.stringContaining("No selected live connection"),
    });
  });

  test("propagates transport and lifecycle failures", async () => {
    const harness = await createHarness();
    await expect(
      Promise.all([
        observe(harness),
        serveOneRequest(harness, (request) => ({
          requestId: request.requestId,
          sessionId: request.sessionId,
          status: "failed",
          error: { code: "payload_too_large", message: "Result exceeds the result size bound" },
          completedAt: new Date().toISOString(),
        })),
      ]),
    ).rejects.toMatchObject({ code: "payload_too_large" });

    const harness2 = await createHarness();
    await expect(
      Promise.all([
        observe(harness2),
        serveOneRequest(harness2, (request) => ({
          requestId: request.requestId,
          sessionId: request.sessionId,
          status: "cancelled",
          completedAt: new Date().toISOString(),
        })),
      ]),
    ).rejects.toMatchObject({ code: "cancelled" });

    const harness3 = await createHarness();
    await expect(
      Promise.all([
        observe(harness3),
        serveOneRequest(harness3, (request) => completedResult(request, { unexpected: true })),
      ]),
    ).rejects.toMatchObject({ code: "malformed_envelope" });
  });

  test("rejects output above eve's inline size guideline", async () => {
    const harness = await createHarness();
    const oversized = observeState({
      screenshot: { mimeType: "image/jpeg", data: "/9j/" + "A".repeat(3 * 1024 * 1024), width: 4, height: 4 },
    });
    await expect(
      Promise.all([
        observe(harness),
        serveOneRequest(harness, (request) => completedResult(request, { ok: true, state: oversized })),
      ]),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  test("settles with lease_expired when no result arrives", async () => {
    const harness = await createHarness();
    const failure = observeSelectedPage({
      broker: harness.broker,
      sessionId: SESSION_ID,
      turnId: "turn-1",
      callId: "call-1",
      bindWaitMs: 1_000,
      resultTimeoutMs: 60,
    });
    await expect(failure).rejects.toMatchObject({ code: "lease_expired" });
  });

  test("settles with browser_unavailable when no worker is bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "astra-browser-control-test-"));
    harnesses.push({ broker: new BrowserBroker({ root, sweep: false }), root, token: "" });
    const harness = harnesses[harnesses.length - 1];
    if (!harness) throw new Error("unreachable");
    const started = Date.now();
    await expect(
      observeSelectedPage({
        broker: harness.broker,
        sessionId: SESSION_ID,
        turnId: "turn-1",
        callId: "call-1",
        bindWaitMs: 80,
      }),
    ).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("cancels the pending request when the turn aborts", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    const pending = observe(harness, { abortSignal: controller.signal });
    await Bun.sleep(50);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("BrowserObserveError", () => {
  test("carries a stable code in the model-facing message", () => {
    const error = new BrowserObserveError("unsupported_page", "This page cannot be controlled");
    expect(error.code).toBe("unsupported_page");
    expect(error.message).toBe("browser_observe failed (unsupported_page): This page cannot be controlled");
  });
});

describe("runBrowserAction", () => {
  test("sends browser cancellation when the result deadline expires", async () => {
    const harness = await createHarness();
    const action = runBrowserAction({
      action: "browser_click",
      input: { tabId: 7, snapshotId: "snapshot-1", ref: 1 },
      ctx: {
        session: { id: SESSION_ID, turn: { id: "turn-1" } },
        callId: "call-timeout",
        abortSignal: new AbortController().signal,
      },
      broker: harness.broker,
      resultTimeoutMs: 60,
    });

    const leasedAction = await harness.broker.lease(harness.token, 1_000);
    expect(leasedAction.requests[0]?.kind).toBe(BROWSER_WORK_KIND_ACTION);
    await expect(action).rejects.toMatchObject({ code: "lease_expired" });

    const leasedCancel = await harness.broker.lease(harness.token, 1_000);
    expect(leasedCancel.requests[0]).toMatchObject({
      kind: BROWSER_WORK_KIND_ACTION_CANCEL,
      payload: { actionId: "call-timeout" },
    });
  });
});
