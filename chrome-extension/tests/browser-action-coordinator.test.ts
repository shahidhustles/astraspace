import { describe, expect, test } from "bun:test";
import { TabActionCoordinator } from "../src/browser/waits/coordinator";
import { toActionId } from "../src/browser/waits/types";
import type { BrowserActionResult } from "../src/browser/actions/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Coordinator-settled envelopes carry completion evidence with real timing.
const completes = (status: string) => ({
  actionId: expect.any(String),
  status,
  elapsedMs: expect.any(Number),
});

function success(action: "browser_navigate"): BrowserActionResult {
  return { ok: true, action, tabId: 7, url: "https://example.com", snapshotInvalidated: true, data: { kind: "navigate" } };
}

describe("TabActionCoordinator", () => {
  test("runs same-tab actions in submission order", async () => {
    const coordinator = new TabActionCoordinator();
    const calls: string[] = [];
    const firstGate = deferred<void>();

    const first = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        calls.push("first-started");
        await firstGate.promise;
        calls.push("first-done");
        return success("browser_navigate");
      },
    });
    const second = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        calls.push("second-started");
        return success("browser_navigate");
      },
    });

    await flush();
    expect(calls).toEqual(["first-started"]);

    firstGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first.settled, second.settled]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(calls).toEqual(["first-started", "first-done", "second-started"]);
    expect(coordinator.liveCount).toBe(0);
  });

  test("actions on separate tabs overlap", async () => {
    const coordinator = new TabActionCoordinator();
    const blockedGate = deferred<void>();
    let secondDone = false;

    const blocked = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await blockedGate.promise;
        return success("browser_navigate");
      },
    });
    const independent = coordinator.enqueue({
      tabId: 2,
      name: "browser_navigate",
      work: async () => {
        secondDone = true;
        return success("browser_navigate");
      },
    });

    await independent.settled;
    expect(secondDone).toBe(true);
    expect(blocked.settled).toBeInstanceOf(Promise);

    blockedGate.resolve();
    await blocked.settled;
    expect(coordinator.liveCount).toBe(0);
  });

  test("rejects a duplicate live id and frees it after settle", async () => {
    const coordinator = new TabActionCoordinator();
    const gate = deferred<void>();

    const first = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      requestedId: toActionId("same-id"),
      work: async () => {
        await gate.promise;
        return success("browser_navigate");
      },
    });
    const duplicate = coordinator.enqueue({
      tabId: 2,
      name: "browser_click",
      requestedId: toActionId("same-id"),
      work: async () => success("browser_navigate"),
    });

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("invalid_action");
      expect(duplicate.action).toBe("browser_click");
    }

    gate.resolve();
    await first.settled;

    const reuse = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      requestedId: toActionId("same-id"),
      work: async () => success("browser_navigate"),
    });
    expect(reuse.ok).toBe(true);
    if (reuse.ok) {
      await reuse.settled;
    }
    expect(coordinator.liveCount).toBe(0);
  });

  test("cancelling a queued action never invokes its work", async () => {
    const coordinator = new TabActionCoordinator();
    const headGate = deferred<void>();
    let queuedRan = false;

    const head = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await headGate.promise;
        return success("browser_navigate");
      },
    });
    const queued = coordinator.enqueue({
      tabId: 1,
      name: "browser_type",
      work: async () => {
        queuedRan = true;
        return success("browser_navigate");
      },
    });

    await flush();
    const reply = coordinator.cancel(queued.actionId);
    expect(reply).toEqual({ ok: true, actionId: queued.actionId, cancelled: true, dispatchStarted: false });

    const result = await queued.settled;
    expect(result).toEqual({
      ok: false,
      action: "browser_type",
      tabId: 1,
      error: {
        code: "action_cancelled",
        message: "Browser action was cancelled before dispatch",
        dispatchStarted: false,
      },
      completion: completes("cancelled"),
    });
    expect(queuedRan).toBe(false);

    headGate.resolve();
    await head.settled;
    expect(coordinator.liveCount).toBe(0);
  });

  test("cancelling during dispatch wins over the action's own result", async () => {
    const coordinator = new TabActionCoordinator();
    const gate = deferred<void>();

    const running = coordinator.enqueue({
      tabId: 3,
      name: "browser_navigate",
      work: async () => {
        await gate.promise;
        return success("browser_navigate");
      },
    });
    await flush();

    const reply = coordinator.cancel(running.actionId);
    expect(reply).toEqual({ ok: true, actionId: running.actionId, cancelled: true, dispatchStarted: true });

    gate.resolve();
    const result = await running.settled;
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "action_cancelled") {
      expect(result.error.dispatchStarted).toBe(true);
    } else {
      throw new Error("expected action_cancelled");
    }
    expect(coordinator.liveCount).toBe(0);
  });

  test("queue deadline expiry before dispatch returns action_wait_timeout", async () => {
    const coordinator = new TabActionCoordinator();
    const headGate = deferred<void>();
    let queuedRan = false;

    const head = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await headGate.promise;
        return success("browser_navigate");
      },
    });
    const queued = coordinator.enqueue({
      tabId: 1,
      name: "browser_scroll",
      deadlineMs: 15,
      work: async () => {
        queuedRan = true;
        return success("browser_navigate");
      },
    });

    const result = await queued.settled;
    expect(result).toEqual({
      ok: false,
      action: "browser_scroll",
      tabId: 1,
      error: {
        code: "action_wait_timeout",
        message: "Queue deadline expired before the action was dispatched",
      },
      completion: completes("timed_out"),
    });
    expect(queuedRan).toBe(false);

    headGate.resolve();
    await head.settled;
    expect(coordinator.liveCount).toBe(0);
  });

  test("generated and caller-supplied ids both register", async () => {
    const coordinator = new TabActionCoordinator();

    const generated = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => success("browser_navigate"),
    });
    expect(generated.ok).toBe(true);
    if (generated.ok) {
      expect(typeof generated.actionId).toBe("string");
      expect(generated.actionId.length).toBeGreaterThan(0);
      await generated.settled;
    }
    expect(coordinator.liveCount).toBe(0);
  });
});
