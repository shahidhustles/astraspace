import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import {
  BROWSER_ACTION_MESSAGE,
  type BrowserActionRequest,
} from "../src/browser/actions/types";
import { dispatchBrowserAction } from "../src/browser/actions/dispatcher";
import { waitForExpectationSignal } from "../src/browser/waits/expectation";
import { BrowserContext } from "../src/browser/context";
import { BrowserPage, defaultPageDeps, type PageDeps } from "../src/browser/page";
import { SnapshotStore } from "../src/browser/snapshot";
import {
  MAX_COMMIT_RECORDS,
  MAX_EVIDENCE_TEXT_CHARS,
  boundText,
  boundedCommits,
  toActionId,
} from "../src/browser/waits/types";
import {
  clickCompletionStatus,
  scrollCompletionStatus,
  signalsCompletionStatus,
} from "../src/browser/waits/status";
import { TabActionCoordinator } from "../src/browser/waits/coordinator";
import type { ActionSettleContext, NavigationCommitRecord, ScrollStabilitySignal } from "../src/browser/waits/types";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Completion evidence is asserted field-wise. Mixing asymmetric matchers into
// an object comparison and then re-comparing that object trips bun's deep
// equal, so this suite never does both.
function expectCompletion(result: unknown, status: string): void {
  const completion = (result as { completion?: { actionId?: string; elapsedMs?: number } }).completion;
  expect(completion?.status).toBe(status);
  expect(typeof completion?.actionId).toBe("string");
  expect(typeof completion?.elapsedMs).toBe("number");
}

class FakeSession extends EventEmitter {
  async send(method: string): Promise<unknown> {
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-1", loaderId: "L1", url: "https://example.com" } } };
    }
    throw new Error(`unexpected send: ${method}`);
  }
}

function navResult(action: "browser_navigate") {
  return { ok: true, action, tabId: 7, url: "https://example.com", snapshotInvalidated: true, data: { kind: "navigate" } };
}

describe("coordinator registry hygiene under every exit", () => {
  test("a queued deadline expiry never runs the work and empties registries", async () => {
    const coordinator = new TabActionCoordinator();
    const headGate = deferred<void>();
    let ranQueued = false;

    const head = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await headGate.promise;
        return navResult("browser_navigate");
      },
    });
    const queued = coordinator.enqueue({
      tabId: 1,
      name: "browser_scroll",
      deadlineMs: 20,
      work: async (): Promise<ReturnType<typeof navResult>> => {
        ranQueued = true;
        return navResult("browser_navigate");
      },
    });

    const result = await queued.settled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "action_wait_timeout", message: "Queue deadline expired before the action was dispatched" },
    });
    expectCompletion(result, "timed_out");
    expect(ranQueued).toBe(false);
    expect(coordinator.liveCount).toBe(1);
    expect(coordinator.queueCount).toBe(0);

    headGate.resolve();
    await head.settled;
    expect(coordinator.liveCount).toBe(0);
    expect(coordinator.queueCount).toBe(0);
  });

  test("cancelling before dispatch skips work entirely", async () => {
    const coordinator = new TabActionCoordinator();
    const headGate = deferred<void>();
    let ran = false;

    const head = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await headGate.promise;
        return navResult("browser_navigate");
      },
    });
    const queued = coordinator.enqueue({
      tabId: 1,
      name: "browser_click",
      work: async (): Promise<ReturnType<typeof navResult>> => {
        ran = true;
        return navResult("browser_navigate");
      },
    });

    await flush();
    const reply = coordinator.cancel(queued.actionId);
    expect(reply.dispatchStarted).toBe(false);
    const result = await queued.settled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "action_cancelled", message: "Browser action was cancelled before dispatch", dispatchStarted: false },
    });
    expectCompletion(result, "cancelled");
    expect(ran).toBe(false);

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped.completion.status).toBe("cancelled");
    expect(typeof roundTripped.completion.actionId).toBe("string");

    headGate.resolve();
    await head.settled;
  });

  test("cancelling mid-dispatch reports uncertain page state", async () => {
    const coordinator = new TabActionCoordinator();
    const gate = deferred<void>();
    const running = coordinator.enqueue({
      tabId: 3,
      name: "browser_click",
      work: async (signal) => {
        // Simulate a dispatched mutation followed by an unsettled barrier.
        signal.throwIfAborted();
        await gate.promise;
        return navResult("browser_navigate");
      },
    });
    await flush();

    const reply = coordinator.cancel(running.actionId);
    expect(reply.dispatchStarted).toBe(true);

    const result = await running.settled;
    expect(result).toMatchObject({
      ok: false,
      action: "browser_click",
      tabId: 3,
      error: { code: "action_cancelled", message: "Browser action was cancelled during dispatch", dispatchStarted: true },
    });
    expectCompletion(result, "cancelled");

    const roundTripped = JSON.parse(JSON.stringify(result));
    expect(roundTripped.completion.status).toBe("cancelled");
    expect(coordinator.liveCount).toBe(0);
    gate.resolve();
  });
});

describe("lifecycle aborts settle live and queued actions", () => {
  const cases: { cause: Parameters<typeof runAbortCause>[0]; code: string; message: string }[] = [
    { cause: "tab_removed", code: "missing_tab", message: "Tab closed during the action" },
    { cause: "debugger_detached", code: "selected_tab_unavailable", message: "Debugger detached during the action" },
    { cause: "connection_replaced", code: "selected_tab_unavailable", message: "Connection was replaced during the action" },
    { cause: "runtime_cleanup", code: "selected_tab_unavailable", message: "Browser runtime cleaned up during the action" },
  ];

  function runAbortCause(cause: string, coordinator: TabActionCoordinator) {
    switch (cause) {
      case "tab_removed":
        return coordinator.abortForTab(1, "tab_removed");
      case "debugger_detached":
        return coordinator.abortForTab(1, "debugger_detached");
      case "connection_replaced":
        return coordinator.abortForTab(1, "connection_replaced");
      default:
        return coordinator.abortAll("runtime_cleanup");
    }
  }

  for (const { cause, code, message } of cases) {
    test(`${cause} ends the active wait with its cause and blocks the queued sibling`, async () => {
      const coordinator = new TabActionCoordinator();
      const gate = deferred<void>();
      let queuedRan = false;

      const active = coordinator.enqueue({
        tabId: 1,
        name: "browser_click",
        work: async () => {
          await gate.promise;
          return navResult("browser_navigate");
        },
      });
      const sibling = coordinator.enqueue({
        tabId: 1,
        name: "browser_type",
        work: async (): Promise<ReturnType<typeof navResult>> => {
          queuedRan = true;
          return navResult("browser_navigate");
        },
      });
      await flush();

      runAbortCause(cause, coordinator);

      const [activeResult, siblingResult] = await Promise.all([active.settled, sibling.settled]);
      expect(activeResult).toMatchObject({
        ok: false,
        action: "browser_click",
        tabId: 1,
        error: { code, message },
      });
      expectCompletion(activeResult, "failed");
      expect(siblingResult).toMatchObject({
        ok: false,
        action: "browser_type",
        tabId: 1,
        error: { code, message },
      });
      expectCompletion(siblingResult, "failed");
      expect(queuedRan).toBe(false);
      expect(coordinator.liveCount).toBe(0);
      expect(coordinator.queueCount).toBe(0);

      // A late resolution of the aborted work cannot resurrect any state.
      gate.resolve();
      await flush();
      expect(coordinator.liveCount).toBe(0);
    });
  }

  test("aborting one tab leaves other tabs untouched", async () => {
    const coordinator = new TabActionCoordinator();
    const gate = deferred<void>();
    const far = coordinator.enqueue({
      tabId: 2,
      name: "browser_navigate",
      work: async () => navResult("browser_navigate"),
    });
    const near = coordinator.enqueue({
      tabId: 1,
      name: "browser_navigate",
      work: async () => {
        await gate.promise;
        return navResult("browser_navigate");
      },
    });
    await flush();

    coordinator.abortForTab(1, "tab_removed");

    const farResult = await far.settled;
    const nearResult = await near.settled;
    expect(farResult.ok).toBe(true);
    expect(nearResult.ok).toBe(false);
    expect(nearResult.ok === false && nearResult.error.code).toBe("missing_tab");
    gate.resolve();
    await flush();
    expect(coordinator.liveCount).toBe(0);
    expect(coordinator.queueCount).toBe(0);
  });
});

describe("context wires Chrome lifecycle events into the coordinator", () => {
  interface Harness {
    context: BrowserContext;
    emitRemoved: (tabId: number) => void;
    emitDetach: (tabId: number) => void;
    gotoCalls: () => number;
    releaseGoto: () => void;
  }

  // Attaches a real BrowserPage whose goto hangs until the test releases it,
  // so an action can sit mid-dispatch while Chrome lifecycle events arrive.
  function setup(): Harness {
    let removedListener: ((tabId: number, info: chrome.tabs.OnRemovedInfo) => void) | null = null;
    let detachListener: ((source: chrome.debugger.Debuggee, reason: string) => void) | null = null;

    const gate = deferred<void>();
    let released = false;
    let calls = 0;
    const session = new FakeSession();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    const fakePage = {
      _client: () => session,
      createCDPSession: async () => session,
      frames: () => [],
      on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
      off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
      goto: async () => {
        calls += 1;
        if (!released) {
          await gate.promise;
        }
        return {};
      },
      goBack: async () => {
        calls += 1;
        if (!released) {
          await gate.promise;
        }
        return {};
      },
      reload: async () => {
        calls += 1;
        if (!released) {
          await gate.promise;
        }
        return {};
      },
      url: () => "https://example.com/hung",
    } as unknown as Page;
    const browser = { connected: true, pages: async () => [fakePage], disconnect: async () => {} } as unknown as Browser;
    const pageDeps: PageDeps = {
      ...defaultPageDeps,
      timeoutMs: 2_000,
      settleTimings: { domQuietMs: 1, networkQuietMs: 1, pollMs: 1 },
      connect: async () => browser,
      connectTab: async () => ({}) as never,
    };

    const context = new BrowserContext({
      queryActiveTab: async () => [{ id: 7, url: "https://example.com" }],
      onRemoved: (listener) => {
        removedListener = listener;
        return () => {};
      },
      onDetach: (listener) => {
        detachListener = listener;
        return () => {};
      },
      diagnostics: () => {},
      pageDeps,
      timeoutMs: 100,
    });

    return {
      context,
      emitRemoved: (tabId) => removedListener?.(tabId, { windowId: 1 } as chrome.tabs.OnRemovedInfo),
      emitDetach: (tabId) => detachListener?.({ tabId }, "target_closed"),
      gotoCalls: () => calls,
      releaseGoto: () => {
        released = true;
        gate.resolve();
      },
    };
  }

  async function runAction(context: BrowserContext, request: Partial<BrowserActionRequest> & { action: BrowserActionRequest["action"] }) {
    const scheduled = context.scheduleAction({
      request: {
        type: BROWSER_ACTION_MESSAGE,
        actionId: null,
        wait: { timeoutMs: 5_000, expectation: null },
        ...request,
      } as BrowserActionRequest,
      tabId: 7,
    });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) {
      throw new Error("unreachable");
    }
    return scheduled;
  }

  async function waitUntilNavigating(h: Harness): Promise<void> {
    for (let i = 0; i < 200 && h.gotoCalls() === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(h.gotoCalls()).toBeGreaterThan(0);
  }

  test("Chrome reporting the tab removed settles the running action with missing_tab", async () => {
    const h = setup();
    expect((await h.context.useActiveTab()).ok).toBe(true);

    const running = await runAction(h.context, { action: "browser_navigate", input: { url: "https://one.example" } });
    await waitUntilNavigating(h);

    h.emitRemoved(7);

    const result = await running.settled;
    expect(result).toMatchObject({
      ok: false,
      action: "browser_navigate",
      tabId: 7,
      error: { code: "missing_tab", message: "Tab closed during the action" },
    });
    expectCompletion(result, "failed");
    expect(h.context.selectedTabId).toBe(null);

    h.releaseGoto();
  });

  test("debugger detach ends the wait even though the transport kept going", async () => {
    const h = setup();
    expect((await h.context.useActiveTab()).ok).toBe(true);

    const running = await runAction(h.context, { action: "browser_back", input: {} });
    await waitUntilNavigating(h);

    h.emitDetach(7);

    const result = await running.settled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "Debugger detached during the action" },
    });
    expectCompletion(result, "failed");
    expect(h.context.selectedTabId).toBe(null);

    h.releaseGoto();
  });

  test("cleanup aborts everything with the runtime_cleanup cause", async () => {
    const h = setup();
    expect((await h.context.useActiveTab()).ok).toBe(true);

    const running = await runAction(h.context, { action: "browser_refresh", input: {} });
    await waitUntilNavigating(h);

    const cleaned = h.context.cleanup();

    const result = await running.settled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "Browser runtime cleaned up during the action" },
    });
    expectCompletion(result, "failed");
    const summary = await cleaned;
    expect(summary.failures).toEqual([]);

    h.releaseGoto();
  });
});

describe("navigation settle timeouts report uncertainty instead of failure", () => {
  class SpyStore extends SnapshotStore {
    invalidatedTabs: number[] = [];
    override invalidate(tabId: number): void {
      this.invalidatedTabs.push(tabId);
      super.invalidate(tabId);
    }
  }

  // The successful Puppeteer call commits nothing, so the wait barrier can
  // never prove where the document landed.
  function silentPageDeps(store: SpyStore, overrides: Partial<PageDeps> = {}) {
    const session = new FakeSession();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    const fakePage = {
      _client: () => session,
      createCDPSession: async () => session,
      frames: () => [],
      on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
      off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
      goto: async () => {},
      url: () => "https://example.com/maybe-landed",
    } as unknown as Page;
    const browser = {
      connected: true,
      pages: async () => [fakePage],
      disconnect: async () => {},
    } as unknown as Browser;
    const deps: PageDeps = {
      ...defaultPageDeps,
      timeoutMs: 100,
      snapshotStore: store,
      connect: async () => browser,
      connectTab: async () => ({}) as never,
      ...overrides,
    };
    return deps;
  }

  function settle(timeoutMs: number | null, signalController = new AbortController()): ActionSettleContext {
    return {
      signal: signalController.signal,
      timeoutMs,
      expectation: null,
      actionId: toActionId("nav-lifecycle"),
      startedAtMs: Date.now(),
    };
  }

  test("an unproven landing returns ok:true with completion.status timed_out and stale refs", async () => {
    const store = new SpyStore();
    const page = new BrowserPage(9, "https://example.com", silentPageDeps(store));
    expect((await page.attach()).ok).toBe(true);

    const result = await page.navigate("https://example.com/next", settle(40));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect("timedOut" in result ? result.timedOut : false).toBe(true);
    expect(store.invalidatedTabs.filter((id) => id === 9).length).toBeGreaterThan(0);
    expect(page.attached).toBe(true);
  });

  test("cancelling the caller signal mid-barrier surfaces action_cancelled", async () => {
    const store = new SpyStore();
    const controller = new AbortController();
    const page = new BrowserPage(9, "https://example.com", silentPageDeps(store, { timeoutMs: 2_000 }));
    expect((await page.attach()).ok).toBe(true);

    const pending = page.navigate("https://example.com/next", settle(null, controller));
    await flush();
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "action_cancelled", message: "Browser action was cancelled during dispatch", dispatchStarted: true },
    });
    expect(store.invalidatedTabs.includes(9)).toBe(true);
  });

  test("the dispatcher maps nav uncertainty onto the envelope with bounded evidence", async () => {
    const store = new SpyStore();
    const page = new BrowserPage(9, "https://example.com", silentPageDeps(store));
    expect((await page.attach()).ok).toBe(true);

    const runtime = {
      selectedTabId: 9,
      navigate: async (_url: string, settleCtx?: ActionSettleContext) =>
        page.navigate("https://example.com/unproven", settleCtx),
    };
    const longUrl = `https://example.com/${"p".repeat(MAX_EVIDENCE_TEXT_CHARS * 2)}`;
    const result = await dispatchBrowserAction(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_navigate",
        input: { url: longUrl },
        actionId: toActionId("nav-envelope"),
        wait: { timeoutMs: 40, expectation: null },
      } as never as BrowserActionRequest,
      runtime as never as Parameters<typeof dispatchBrowserAction>[1],
      settle(40),
    );

    expect(result).toMatchObject({
      ok: true,
      action: "browser_navigate",
      snapshotInvalidated: true,
      completion: { status: "timed_out" },
    });
    expect(result.ok && result.url.length).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS + "[truncated]".length + 4);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("a dead transport mid-navigation aborts the whole entry as connection_replaced", async () => {
    const store = new SpyStore();
    let connected = true;
    const session = new FakeSession();
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    const fakePage = {
      _client: () => session,
      createCDPSession: async () => session,
      frames: () => [],
      on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
      off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
      goto: async () => {
        connected = false;
        throw new Error("ProtocolError: target crashed");
      },
      url: () => "https://example.com/x",
    } as unknown as Page;
    const browser = {
      get connected() {
        return connected;
      },
      pages: async () => [fakePage],
      disconnect: async () => {},
    } as unknown as Browser;
    const deps: PageDeps = {
      ...defaultPageDeps,
      timeoutMs: 200,
      snapshotStore: store,
      connect: async () => browser,
      connectTab: async () => ({}) as never,
    };
    const page = new BrowserPage(11, "https://example.com", deps);
    expect((await page.attach()).ok).toBe(true);

    const settleCtx = settle(300, new AbortController());
    settleCtx.actionId = toActionId("dead-transport");
    const result = await page.navigate("https://example.com/dead", settleCtx);

    // detachIfDisconnected fired with the generation change, so the wrapper
    // sees stale snapshots and the page is unusable going forward.
    expect(store.invalidatedTabs.includes(11)).toBe(true);
    expect(page.attached).toBe(false);
    expect(result).toMatchObject({ ok: false, error: { code: "navigation_failed" } });
  });
});

describe("bounded evidence crossing the runtime boundary", () => {
  test("boundText caps page-derived strings behind a marker", () => {
    const short = "https://example.com/a";
    expect(boundText(short)).toBe(short);
    const huge = `x`.repeat(MAX_EVIDENCE_TEXT_CHARS + 50);
    const bounded = boundText(huge);
    expect(bounded.length).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS + 16);
    expect(bounded.endsWith("[truncated]")).toBe(true);
  });

  test("boundedCommits caps the array and bounds record URLs", () => {
    const makeCommit = (i: number): NavigationCommitRecord => ({
      kind: i % 2 === 0 ? "main_commit" : "child_commit",
      frameId: `f${i}`,
      parentFrameId: null,
      oldUrl: `https://old.example/${`y`.repeat(3000)}`,
      newUrl: `https://new.example/${i}/${`z`.repeat(3000)}`,
      loaderId: `L${i}`,
      documentEpoch: i + 1,
      navigationEpoch: i + 1,
    });
    const storm = Array.from({ length: MAX_COMMIT_RECORDS + 15 }, (_, i) => makeCommit(i));
    const bounded = boundedCommits(storm);
    expect(bounded.length).toBe(MAX_COMMIT_RECORDS);
    expect(bounded[0].kind).toBe(storm[0].kind);
    for (const commit of bounded) {
      expect(commit.oldUrl.length).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS + 16);
      expect(commit.newUrl.length).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS + 16);
    }
    expect(JSON.parse(JSON.stringify(bounded))).toEqual(bounded);
  });

  test("dispatch envelopes bound oversized helper URLs and stay JSON-safe", async () => {
    const hugeUrl = `https://example.com/${"u".repeat(MAX_EVIDENCE_TEXT_CHARS * 3)}`;
    const runtimeBase = {
      selectedTabId: 7,
      useActiveTab: async () => ({ ok: true, tabId: 7 }),
      observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "n/a" } }),
      navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "n/a" } }),
      goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "n/a" } }),
      refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "n/a" } }),
      click: async () => ({ ok: false, error: { code: "stale_ref", message: "n/a", target: {} } }),
      type: async () => ({ ok: true, url: hugeUrl }),
      clearInput: async () => ({ ok: true, url: hugeUrl }),
      keypress: async () => ({ ok: true, url: hugeUrl }),
      scroll: async () => ({
        ok: true,
        url: hugeUrl,
        position: { x: 0, y: 0 },
      }),
      scrollToText: async () => ({
        ok: true,
        url: hugeUrl,
        position: { x: 0, y: 0 },
      }),
      getSelectOptions: async () => ({ ok: true, url: hugeUrl, options: [], optionsTruncated: false }),
      selectOption: async () => ({ ok: true, url: hugeUrl, selectedIndex: 0 }),
      openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "n/a" } }),
      switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "n/a" } }),
      closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "n/a" } }),
      listTabs: async () => ({ ok: true, tabs: [] }),
    } as never as Parameters<typeof dispatchBrowserAction>[1];

    const bigTextRequest: BrowserActionRequest = {
      type: BROWSER_ACTION_MESSAGE,
      action: "browser_type",
      input: { target: { tabId: 7, snapshotId: toActionId("snap") as never, ref: 1 }, text: "hello" },
      actionId: toActionId("bounds-type"),
      wait: { timeoutMs: null, expectation: null },
    } as never as BrowserActionRequest;
    const outcome = await dispatchBrowserAction(bigTextRequest, runtimeBase, {
      signal: new AbortController().signal,
      timeoutMs: null,
      expectation: null,
      actionId: toActionId("bounds-type"),
      startedAtMs: Date.now(),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.url.startsWith("https://example.com/")).toBe(true);
    expect(outcome.ok && outcome.url.length).toBeLessThanOrEqual(MAX_EVIDENCE_TEXT_CHARS + 16);
    expect(outcome.ok && outcome.url.endsWith("[truncated]")).toBe(true);
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});

describe("completion statuses derive from real evidence", () => {
  const quietBoth = {
    network: { status: "quiet", idleMs: 400, ignoredRequests: 0 },
    dom: { status: "quiet", idleMs: 350, watchedFrames: 2 },
  } as const;
  const stalledBoth = {
    network: { status: "activity_timeout", timeoutMs: 900, pendingCount: 2, ignoredRequests: 1 },
    dom: { status: "activity_timeout", timeoutMs: 900, watchedFrames: 1 },
  } as const;

  test("signals quiet prove typing-style actions; activity timeouts do not", () => {
    expect(signalsCompletionStatus(quietBoth)).toBe("completed");
    expect(signalsCompletionStatus(stalledBoth)).toBe("timed_out");
    expect(signalsCompletionStatus(undefined)).toBe("completed");
  });

  test("clicks need the strongest hop, exact satisfaction, or stable layout", () => {
    expect(clickCompletionStatus({ outcome: "navigation" })).toBe("completed");
    expect(clickCompletionStatus({ outcome: "same_document" })).toBe("completed");
    expect(clickCompletionStatus({ outcome: "dom_update", layout: { status: "stable", samples: 2, maxDeltaPx: 1 }, signals: quietBoth })).toBe("completed");
    expect(clickCompletionStatus({ outcome: "dom_update", layout: { status: "unstable", timeoutMs: 800, sampleCount: 5, maxDeltaPx: 30 } })).toBe("timed_out");
    expect(clickCompletionStatus({ expectation: { status: "satisfied", intent: "appear", scope: "main_document" } })).toBe("completed");
    expect(clickCompletionStatus({ expectation: { status: "unresolved", intent: "appear", timeoutMs: 700 } })).toBe("timed_out");
    expect(clickCompletionStatus({ expectation: { status: "cancelled", intent: "disappear" } })).toBe("cancelled");
    expect(clickCompletionStatus({})).toBe("completed");
  });

  test("scroll stability decides scroll completion", () => {
    const stable: ScrollStabilitySignal = { status: "stable", samples: 2, maxDeltaPx: 0 };
    const unstable: ScrollStabilitySignal = {
      status: "unsettled",
      reason: "unstable",
      timeoutMs: 500,
      sampleCount: 4,
      maxDeltaPx: 44,
      targetY: 600,
      lastY: 420,
    };
    expect(scrollCompletionStatus(stable)).toBe("completed");
    expect(scrollCompletionStatus(unstable)).toBe("timed_out");
  });
});

describe("read-only evidence probes retry once inside the original budget", () => {
  function probePage(evalImpl: (callIndex: number) => Promise<number>, frameCount = 1) {
    const calls = { count: 0 };
    const evaluate = async () => {
      calls.count += 1;
      return evalImpl(calls.count - 1);
    };
    const frames = Array.from({ length: frameCount }, (_, i) => ({
      evaluate,
      __index: i,
    }));
    return {
      page: {
        frames: () => frames,
        mainFrame: () => frames[0],
      } as unknown as Page,
      calls,
    };
  }

  test("a transient probe failure retries once and still satisfies appearance", async () => {
    let threwOnce = false;
    const { page } = probePage(() => {
      if (!threwOnce) {
        threwOnce = true;
        throw new Error("frame evaluation context destroyed");
      }
      return 1;
    });

    const signal = await waitForExpectationSignal(
      page,
      { intent: "appear", role: "button", name: "Submit" },
      100,
      undefined,
      1,
    );
    expect(signal.status).toBe("satisfied");
    expect(signal.status === "satisfied" ? signal.intent : "").toBe("appear");
  });

  test("two consecutive probe failures surface unresolved within the original deadline", async () => {
    const startedAt = Date.now();
    const { page } = probePage(() => {
      throw new Error("still broken");
    });

    const signal = await waitForExpectationSignal(
      page,
      { intent: "appear", role: "button", name: "Submit" },
      60,
      undefined,
      1,
    );

    expect(signal.status).toBe("unresolved");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("the aborted signal wins over further polling", async () => {
    const controller = new AbortController();
    controller.abort();
    const { page } = probePage(() => Promise.resolve(1));

    const signal = await waitForExpectationSignal(
      page,
      { intent: "disappear", role: "button", name: "Submit" },
      100,
      controller.signal,
      1,
    );
    expect(signal.status).toBe("cancelled");
  });
});
