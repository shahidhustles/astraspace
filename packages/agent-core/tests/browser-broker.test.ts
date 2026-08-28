import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_REQUEST_BYTES,
  type BrowserWorkResult,
} from "@astra-space/browser-control-contract";
import { BrowserBroker, BrowserBrokerError } from "../agent/lib/browser-broker";

interface BrokerHarness {
  broker: BrowserBroker;
  root: string;
}

const harnesses: BrokerHarness[] = [];

async function createBroker(
  overrides: Partial<ConstructorParameters<typeof BrowserBroker>[0]> = {},
): Promise<BrokerHarness> {
  const root = await mkdtemp(join(tmpdir(), "astra-broker-test-"));
  const broker = new BrowserBroker({ root, sweep: false, ...overrides });
  harnesses.push({ broker, root });
  return { broker, root };
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (!harness) break;
    await harness.broker.close();
    await rm(harness.root, { recursive: true, force: true });
  }
});

function enqueueInput(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    turnId: "turn_1",
    callId: "call_1",
    kind: "browser.observe",
    payload: { url: "https://example.test" },
    ...overrides,
  };
}

describe("BrowserBroker bind", () => {
  test("bind returns a token and generation, and rejects an empty session", async () => {
    const { broker } = await createBroker();

    const bind = await broker.bind("ses_1");
    expect(bind.sessionId).toBe("ses_1");
    expect(bind.connectionToken.length).toBeGreaterThan(20);
    expect(bind.generation).toBe(1);

    expect(broker.bind("")).rejects.toThrow(BrowserBrokerError);
  });

  test("rebinding rotates the token and invalidates the previous generation", async () => {
    const { broker } = await createBroker();

    const first = await broker.bind("ses_1");
    const second = await broker.bind("ses_2");

    expect(second.connectionToken).not.toBe(first.connectionToken);
    expect(second.generation).toBe(2);

    await expect(broker.lease(first.connectionToken, 0)).rejects.toMatchObject({
      code: "invalid_token",
    });
    await expect(
      broker.submitResult(first.connectionToken, {
        requestId: "none",
        sessionId: "ses_1",
        status: "cancelled",
        completedAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("BrowserBroker enqueue and lease", () => {
  test("leases the enqueued request only for the bound session", async () => {
    const { broker } = await createBroker();
    const bind = await broker.bind("ses_1");
    await broker.enqueue("ses_1", enqueueInput("ses_1"));

    const leased = await broker.lease(bind.connectionToken, 0);
    expect(leased.requests).toHaveLength(1);
    expect(leased.requests[0]?.sessionId).toBe("ses_1");
    expect(leased.requests[0]?.kind).toBe("browser.observe");
    expect(leased.requests[0]?.payload).toEqual({ url: "https://example.test" });

    const drained = await broker.lease(bind.connectionToken, 0);
    expect(drained.requests).toHaveLength(0);
  });

  test("requests for other sessions never lease through this connection", async () => {
    const { broker } = await createBroker();
    const bind = await broker.bind("ses_1");
    await broker.enqueue("ses_2", enqueueInput("ses_2", { callId: "call_other" }));

    const leased = await broker.lease(bind.connectionToken, 0);
    expect(leased.requests).toHaveLength(0);

    const other = await createBroker();
    const otherBind = await other.broker.bind("ses_2");
    const leasedOther = await other.broker.lease(otherBind.connectionToken, 0);
    expect(leasedOther.requests).toHaveLength(0);

    await other.broker.enqueue("ses_2", enqueueInput("ses_2", { callId: "call_other" }));
    const leasedOwn = await other.broker.lease(otherBind.connectionToken, 0);
    expect(leasedOwn.requests).toHaveLength(1);
    expect(leasedOwn.requests[0]?.callId).toBe("call_other");
  });

  test("claiming is atomic under concurrent leases", async () => {
    const { broker } = await createBroker();
    const bind = await broker.bind("ses_1");
    await broker.enqueue("ses_1", enqueueInput("ses_1"));

    const results = await Promise.all([
      broker.lease(bind.connectionToken, 0),
      broker.lease(bind.connectionToken, 0),
      broker.lease(bind.connectionToken, 0),
    ]);

    const leasedCount = results.filter((entry) => entry.requests.length === 1).length;
    expect(leasedCount).toBe(1);
  });

  test("an expired lease releases the request for another claim", async () => {
    let clock = 1_000_000;
    const { broker } = await createBroker({
      now: () => clock,
      timings: { leaseMs: 1_000, pollIntervalMs: 1 },
    });
    const bind = await broker.bind("ses_1");
    await broker.enqueue("ses_1", enqueueInput("ses_1"));

    const first = await broker.lease(bind.connectionToken, 0);
    expect(first.requests).toHaveLength(1);

    const blocked = await broker.lease(bind.connectionToken, 0);
    expect(blocked.requests).toHaveLength(0);

    clock += 2_000;
    const swept = await broker.sweep();
    expect(swept).toBeGreaterThan(0);

    const reclaimed = await broker.lease(bind.connectionToken, 0);
    expect(reclaimed.requests).toHaveLength(1);
    expect(reclaimed.requests[0]?.requestId).toBe(first.requests[0]?.requestId);
  });

  test("long-poll waits for a request that arrives mid-wait", async () => {
    const { broker } = await createBroker({ timings: { pollIntervalMs: 1 } });
    const bind = await broker.bind("ses_1");

    const waiting = broker.lease(bind.connectionToken, 5_000);
    await Bun.sleep(50);
    await broker.enqueue("ses_1", enqueueInput("ses_1", { callId: "call_late" }));

    const leased = await waiting;
    expect(leased.requests).toHaveLength(1);
    expect(leased.requests[0]?.callId).toBe("call_late");
  });
});

describe("BrowserBroker results", () => {
  test("a leased request settles exactly once and the result is readable", async () => {
    const { broker } = await createBroker();
    const bind = await broker.bind("ses_1");
    const enqueued = await broker.enqueue("ses_1", enqueueInput("ses_1"));
    await broker.lease(bind.connectionToken, 0);

    const result: BrowserWorkResult = {
      requestId: enqueued.requestId,
      sessionId: "ses_1",
      status: "completed",
      payload: { title: "Example" },
      completedAt: new Date().toISOString(),
    };
    await broker.submitResult(bind.connectionToken, result);

    const settled = await broker.waitForResult("ses_1", enqueued.requestId, 1_000);
    expect(settled.status).toBe("completed");
    if (settled.status === "completed") {
      expect(settled.payload).toEqual({ title: "Example" });
    }

    await broker.submitResult(bind.connectionToken, {
      ...result,
      payload: { title: "Second write" },
    });
    const unchanged = await broker.waitForResult("ses_1", enqueued.requestId, 1_000);
    expect(unchanged.status).toBe("completed");
    if (unchanged.status === "completed") {
      expect(unchanged.payload).toEqual({ title: "Example" });
    }
  });

  test("submitting a result with the wrong session or unknown request fails typed", async () => {
    const { broker } = await createBroker();
    const bind = await broker.bind("ses_1");
    const enqueued = await broker.enqueue("ses_1", enqueueInput("ses_1"));

    const wrongSession: BrowserWorkResult = {
      requestId: enqueued.requestId,
      sessionId: "ses_2",
      status: "cancelled",
      completedAt: new Date().toISOString(),
    };
    await expect(broker.submitResult(bind.connectionToken, wrongSession)).rejects.toMatchObject({
      code: "invalid_session",
    });

    const unknownResult: BrowserWorkResult = {
      requestId: "does-not-exist",
      sessionId: "ses_1",
      status: "cancelled",
      completedAt: new Date().toISOString(),
    };
    await expect(broker.submitResult(bind.connectionToken, unknownResult)).rejects.toMatchObject({
      code: "unknown_request",
    });
  });

  test("an oversized or non-JSON-safe request payload is rejected", async () => {
    const { broker } = await createBroker();
    await broker.bind("ses_1");

    await expect(
      broker.enqueue(
        "ses_1",
        enqueueInput("ses_1", { payload: { blob: "x".repeat(MAX_REQUEST_BYTES) } }),
      ),
    ).rejects.toMatchObject({ code: "payload_too_large" });

    await expect(
      broker.enqueue("ses_1", enqueueInput("ses_1", { payload: { big: 1n } })),
    ).rejects.toMatchObject({ code: "malformed_envelope" });
  });

  test("waiting past the deadline cancels the request and throws lease_expired", async () => {
    const { broker } = await createBroker();
    await broker.bind("ses_1");
    const enqueued = await broker.enqueue("ses_1", enqueueInput("ses_1"));

    await expect(broker.waitForResult("ses_1", enqueued.requestId, 10)).rejects.toMatchObject({
      code: "lease_expired",
    });

    const result = await broker.waitForResult("ses_1", enqueued.requestId, 1_000);
    expect(result.status).toBe("cancelled");
  });
});

describe("BrowserBroker lifecycle and isolation", () => {
  test("brokers with different roots do not share connections or requests", async () => {
    const left = await createBroker();
    const right = await createBroker();

    const leftBind = await left.broker.bind("ses_1");
    await left.broker.enqueue("ses_1", enqueueInput("ses_1"));

    await expect(right.broker.lease(leftBind.connectionToken, 0)).rejects.toMatchObject({
      code: "invalid_token",
    });

    const rightBind = await right.broker.bind("ses_1");
    const rightLease = await right.broker.lease(rightBind.connectionToken, 0);
    expect(rightLease.requests).toHaveLength(0);
  });

  test("sweep enforces retention and pending deadlines with bounded files", async () => {
    let clock = 10_000_000;
    const { broker, root } = await createBroker({
      now: () => clock,
      timings: { resultRetentionMs: 60_000, pendingMaxAgeMs: 60_000 },
    });
    const bind = await broker.bind("ses_1");
    const settled = await broker.enqueue("ses_1", enqueueInput("ses_1"));
    await broker.lease(bind.connectionToken, 0);
    await broker.submitResult(bind.connectionToken, {
      requestId: settled.requestId,
      sessionId: "ses_1",
      status: "completed",
      payload: {},
      completedAt: new Date(clock).toISOString(),
    });
    const stale = await broker.enqueue("ses_1", enqueueInput("ses_1", { callId: "call_stale" }));

    clock += 2_000;
    await broker.sweep();
    const fresh = await broker.waitForResult("ses_1", settled.requestId, 1_000);
    expect(fresh.status).toBe("completed");

    clock += 120_000;
    await broker.sweep();
    const staleResult = await broker.waitForResult("ses_1", stale.requestId, 1_000);
    expect(staleResult.status).toBe("failed");
    expect(
      await stat(join(root, "results", `${settled.requestId}.json`)).catch(() => null),
    ).toBeNull();

    clock += 70_000;
    await broker.sweep();
    const remaining = await readdir(join(root, "results"));
    expect(remaining).toHaveLength(0);
  });

  test("broker records live under the OS temporary directory, never the repository", async () => {
    const { broker, root } = await createBroker();
    await broker.bind("ses_1");
    await broker.enqueue("ses_1", enqueueInput("ses_1"));

    expect(root.startsWith(tmpdir())).toBe(true);
    const pending = await readdir(join(root, "pending"));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.endsWith(".json")).toBe(true);
  });
});
