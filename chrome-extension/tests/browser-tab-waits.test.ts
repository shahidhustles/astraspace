import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import type { BrowserActionRequest, BrowserActionResult } from "../src/browser/actions/types";
import { BrowserContext } from "../src/browser/context";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage } from "../src/browser/runtime";
import type { PageDeps } from "../src/browser/page";
import { SnapshotStore } from "../src/browser/snapshot";
import type { GroundedTarget } from "../src/browser/types";
import type { ActionId, TabLifecycleMeasurement } from "../src/browser/waits/types";

class SpyStore extends SnapshotStore {
  invalidatedTabs: number[] = [];

  invalidate(tabId: number): void {
    this.invalidatedTabs.push(tabId);
    super.invalidate(tabId);
  }
}

interface FakeBrowser extends Browser {
  disconnectCalls: number;
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

  async detach(): Promise<void> {}
}

function fakePage(): FakePage {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  let session: FakeSession | null = null;
  return {
    frames: () => [],
    on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
    createCDPSession: async () => new FakeSession(),
    _client: () => {
      if (!session) {
        session = new FakeSession();
      }
      return session;
    },
    url: () => "https://example.com",
  } as unknown as FakePage;
}

function fakeBrowser(page: FakePage): FakeBrowser {
  const browser = {
    connected: true,
    disconnectCalls: 0,
    pages: async () => [page],
    disconnect: async () => {
      browser.disconnectCalls += 1;
    },
  } as unknown as FakeBrowser;
  void page;
  return browser;
}

// Scripted knobs so each close and switch outcome is fully controlled.
interface Controls {
  removal: "resolve" | "reject-busy" | "hang";
  removeCalls: number[];
  activateImmediately: boolean;
  releaseHang: () => void;
}

interface ListenerTracker {
  updated: number;
  activated: number;
  removed: number;
  detached: number;
}

const BASE_LISTENERS: ListenerTracker = { updated: 0, activated: 0, removed: 1, detached: 1 };

interface Harness {
  context: BrowserContext;
  store: SpyStore;
  controls: Controls;
  browsers: FakeBrowser[];
  api: {
    emitUpdated(tabId: number, url: string): void;
    emitActivated(tabId: number): void;
    emitRemoved(tabId: number): void;
    listenerCounts(): ListenerTracker;
  };
  // Opens through context.openTab, drives it to attach, and returns the
  // Chrome-assigned tab id.
  openAndSelect(url: string): Promise<number>;
  totalDisconnects(): number;
}

async function microtasks(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function setup(): Harness {
  const store = new SpyStore();
  let hangingResolve: (() => void) | null = null;
  const controls: Controls = {
    removal: "resolve",
    removeCalls: [],
    activateImmediately: false,
    releaseHang: () => hangingResolve?.(),
  };

  const updatedListeners = new Set<
    (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
  >();
  const activatedListeners = new Set<(info: chrome.tabs.OnActivatedInfo) => void>();
  const removedListeners = new Set<(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void>();
  const detachedListeners = new Set<(source: chrome.debugger.Debuggee, reason: string) => void>();

  // Assigned id to latest observed URL for every created tab; drives queryTabs.
  const knownCreated = new Map<number, string>();
  let lastCreatedId: number | null = null;

  const pageDeps: PageDeps = {
    connect: async () => {
      const browser = fakeBrowser(fakePage());
      browsers.push(browser);
      return browser;
    },
    connectTab: async () => ({}) as never,
    timeoutMs: 50,
    settleTimings: { domQuietMs: 1, networkQuietMs: 1, pollMs: 1 },
    snapshotStore: store,
  };

  const context = new BrowserContext({
    queryActiveTab: async () => [{ id: 7, url: "https://origin.example" } as chrome.tabs.Tab],
    queryTabs: async () =>
      [
        { id: 7, url: "https://origin.example", title: "Origin" },
        ...[...knownCreated].map(([tabId, url]) => ({ id: tabId, url, title: `Tab ${tabId}` })),
      ] as chrome.tabs.Tab[],
    createTab: async (url) => {
      void url;
      const nextId = 40 + knownCreated.size;
      lastCreatedId = nextId;
      knownCreated.set(nextId, "about:blank");
      return { id: nextId, url: "about:blank" } as chrome.tabs.Tab;
    },
    updateTab: async (tabId) =>
      ({
        id: tabId,
        active: false,
        ...(controls.activateImmediately ? { active: true } : {}),
        url: `https://tab-${tabId}.example`,
      }) as chrome.tabs.Tab,
    removeTab: async (tabId: number) => {
      controls.removeCalls.push(tabId);
      if (controls.removal === "hang") {
        await new Promise<void>((resolve) => {
          hangingResolve = resolve;
        });
        return;
      }
      if (controls.removal === "reject-busy") {
        throw new Error("Tabs cannot be edited right now");
      }
    },
    onUpdated: (listener) => {
      updatedListeners.add(listener);
      return () => updatedListeners.delete(listener);
    },
    onActivated: (listener) => {
      activatedListeners.add(listener);
      return () => activatedListeners.delete(listener);
    },
    onRemoved: (listener) => {
      removedListeners.add(listener);
      return () => removedListeners.delete(listener);
    },
    onDetach: (listener) => {
      detachedListeners.add(listener);
      return () => detachedListeners.delete(listener);
    },
    diagnostics: () => {},
    pageDeps,
    timeoutMs: 50,
  });

  const browsers: FakeBrowser[] = [];
  // Resolves once pageDeps.connect runs for one transport creation.
  const connectSpy = (): FakeBrowser => {
    const browser = fakeBrowser(fakePage());
    browsers.push(browser);
    return browser;
  };
  void connectSpy;

  const harness: Harness = {
    context,
    store,
    controls,
    browsers,
    api: {
      emitUpdated: (tabId, url) => {
        knownCreated.set(tabId, url);
        for (const listener of updatedListeners) {
          listener(tabId, {}, { id: tabId, url } as chrome.tabs.Tab);
        }
      },
      emitActivated: (tabId) => {
        for (const listener of activatedListeners) {
          listener({ tabId, windowId: 1 });
        }
      },
      emitRemoved: (tabId) => {
        for (const listener of removedListeners) {
          listener(tabId, { isWindowClosing: false, windowId: 1 });
        }
      },
      listenerCounts: () => ({
        updated: updatedListeners.size,
        activated: activatedListeners.size,
        removed: removedListeners.size,
        detached: detachedListeners.size,
      }),
    },
    openAndSelect: async (url) => {
      const pending = context.openTab(url);
      await microtasks(2);
      if (lastCreatedId === null) {
        throw new Error("fixture createTab never ran");
      }
      const createdId = lastCreatedId;
      harness.api.emitUpdated(createdId, url);
      const result = await pending;
      if (!result.ok) {
        throw new Error(`fixture failed to open tab ${createdId}: ${result.error.code}`);
      }
      knownCreated.set(createdId, url);
      return createdId;
    },
    totalDisconnects: () => {
      let total = 0;
      for (const browser of browsers) {
        total += browser.disconnectCalls;
      }
      return total;
    },
  };

  return harness;
}

async function runAction(
  context: BrowserContext,
  request: BrowserActionRequest,
): Promise<BrowserActionResult> {
  const scheduled = context.scheduleAction({ request, tabId: context.selectedTabId ?? 0 });
  if (!scheduled.ok) {
    throw new Error(`fixture schedule failed: ${scheduled.error.message}`);
  }
  return scheduled.settled;
}

function lifecycleOf(result: Extract<BrowserActionResult, { ok: true }>): TabLifecycleMeasurement {
  const data = result.data as { measured?: TabLifecycleMeasurement };
  if (!data.measured) {
    throw new Error("expected lifecycle measurement in data");
  }
  return data.measured;
}

describe("open tab lifecycle", () => {
  test("completes once the controllable URL is exposed and the extension attaches", async () => {
    const h = setup();

    const scheduled = h.context.scheduleAction({
      request: {
        type: BROWSER_ACTION_MESSAGE,
        actionId: "wait-open-1" as ActionId,
        wait: null,
        action: "browser_open_tab",
        input: { url: "https://opened.example" },
      },
      tabId: 0,
    });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) {
      throw new Error("unreachable");
    }

    // Dispatch drains far enough to have armed tabs.onUpdated and created
    // the tab; exposing the controllable URL finishes the wait.
    await microtasks();
    h.api.emitUpdated(40, "https://opened.example");

    const result = await scheduled.settled;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.action).toBe("browser_open_tab");
    expect(result.snapshotInvalidated).toBe(false);
    expect(lifecycleOf(result)).toEqual({
      actionId: "wait-open-1",
      lifecycle: { status: "completed", completedBy: "controllable_url_and_attach", elapsedMs: expect.any(Number) },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    // Nothing transient lingers, and late updates are inert.
    h.api.emitUpdated(40, "https://elsewhere.example");
    expect(h.api.listenerCounts()).toEqual(BASE_LISTENERS);
    expect(h.context.tabCount).toBe(1);
  });

  test("a URL-policy failure keeps the world untouched", async () => {
    const h = setup();

    const result = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-open-2" as ActionId,
      wait: null,
      action: "browser_open_tab",
      input: { url: "chrome://newtab" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported_page" } });
    expect(h.context.tabCount).toBe(0);
    expect(h.api.listenerCounts().updated).toBe(BASE_LISTENERS.updated);
  });
});

describe("switch tab lifecycle", () => {
  test("completes on activation plus attachment and reports switch evidence", async () => {
    const h = setup();
    const openedId = await h.openAndSelect("https://secondary.example");

    const pending = runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-switch-1" as ActionId,
      wait: { timeoutMs: 900, expectation: null },
      action: "browser_switch_tab",
      input: { tabId: 7 },
    });
    await microtasks();
    h.api.emitActivated(7);

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.action).toBe("browser_switch_tab");
    expect(result.snapshotInvalidated).toBe(false);
    expect(lifecycleOf(result)).toEqual({
      actionId: "wait-switch-1",
      lifecycle: { status: "completed", completedBy: "activation_and_attach", elapsedMs: expect.any(Number) },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(h.context.selectedTabId).toBe(7);
    expect(h.api.listenerCounts()).toEqual(BASE_LISTENERS);
    void openedId;
  });

  test("an already-active tab completes without an activation event", async () => {
    const h = setup();
    await h.openAndSelect("https://secondary.example");
    h.controls.activateImmediately = true;

    const result = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-switch-2" as ActionId,
      wait: { timeoutMs: 400, expectation: null },
      action: "browser_switch_tab",
      input: { tabId: 7 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(lifecycleOf(result).lifecycle.completedBy).toBe("activation_and_attach");
    expect(h.context.selectedTabId).toBe(7);
    expect(h.api.listenerCounts()).toEqual(BASE_LISTENERS);
  });

  test("activation that never arrives keeps the previous selection", async () => {
    const h = setup();
    const openedId = await h.openAndSelect("https://secondary.example");
    await h.context.switchTab(openedId);

    const result = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-switch-3" as ActionId,
      wait: null,
      action: "browser_switch_tab",
      input: { tabId: 7 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "lifecycle_timeout", message: "Tab did not activate" },
    });
    expect(h.context.selectedTabId).toBe(openedId);
    expect(h.api.listenerCounts().activated).toBe(BASE_LISTENERS.activated);
  });
});

describe("close tab lifecycle", () => {
  test("confirms removal, reports evidence, and clears state exactly once", async () => {
    const h = setup();
    await h.context.useActiveTab();
    const victimId = await h.openAndSelect("https://secondary.example");

    const result = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-close-1" as ActionId,
      wait: null,
      action: "browser_close_tab",
      input: { tabId: victimId },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.action).toBe("browser_close_tab");
    expect(result.snapshotInvalidated).toBe(true);
    expect(lifecycleOf(result)).toEqual({
      actionId: "wait-close-1",
      lifecycle: { status: "completed", completedBy: "removal_confirmed", elapsedMs: expect.any(Number) },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);

    // Duplicate removal broadcasts must not tear down anything twice.
    h.api.emitRemoved(victimId);
    h.api.emitRemoved(victimId);
    expect(h.totalDisconnects()).toBe(1);
    expect(h.store.invalidatedTabs.filter((tabId) => tabId === victimId)).toHaveLength(1);
    expect(h.controls.removeCalls).toEqual([victimId]);
    expect(h.api.listenerCounts()).toEqual(BASE_LISTENERS);
  });

  test("a rejected removal keeps the connection alive and selectable", async () => {
    const h = setup();
    await h.context.useActiveTab();
    const victimId = await h.openAndSelect("https://secondary.example");
    h.controls.removal = "reject-busy";

    const failure = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-close-2" as ActionId,
      wait: null,
      action: "browser_close_tab",
      input: { tabId: victimId },
    });

    expect(failure).toMatchObject({ ok: false, error: { code: "chrome_api_error" } });
    expect(h.context.tabCount).toBe(2);
    expect(h.totalDisconnects()).toBe(0);
    expect(h.store.invalidatedTabs).toEqual([]);

    // Retained means usable: the very next close goes through cleanly.
    h.controls.removal = "resolve";
    const retried = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-close-3" as ActionId,
      wait: null,
      action: "browser_close_tab",
      input: { tabId: victimId },
    });
    expect(retried.ok).toBe(true);
    expect(h.context.tabCount).toBe(1);
    expect(h.totalDisconnects()).toBe(1);
  });

  test("a stuck removal settles under the caller budget and leaves state intact", async () => {
    const h = setup();
    await h.context.useActiveTab();
    const victimId = await h.openAndSelect("https://secondary.example");
    h.controls.removal = "hang";

    const result = await runAction(h.context, {
      type: BROWSER_ACTION_MESSAGE,
      actionId: "wait-close-4" as ActionId,
      wait: { timeoutMs: 80, expectation: null },
      action: "browser_close_tab",
      input: { tabId: victimId },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "action_wait_timeout" } });
    expect(h.context.tabCount).toBe(2);
    expect(h.context.selectedTabId).toBe(victimId);
    expect(h.totalDisconnects()).toBe(0);
    expect(h.store.invalidatedTabs).toEqual([]);
    expect(h.api.listenerCounts().removed).toBe(BASE_LISTENERS.removed);

    // Chrome finishing later reconciles the record exactly once.
    h.controls.releaseHang();
    h.api.emitRemoved(victimId);
    expect(h.context.tabCount).toBe(1);
    expect(h.totalDisconnects()).toBe(1);
    expect(h.store.invalidatedTabs).toEqual([victimId]);
  });

  test("cancelling mid-dispatch stops the close and keeps the page selectable", async () => {
    const h = setup();
    await h.context.useActiveTab();
    const victimId = await h.openAndSelect("https://secondary.example");
    h.controls.removal = "hang";

    const scheduled = h.context.scheduleAction({
      request: {
        type: BROWSER_ACTION_MESSAGE,
        actionId: "wait-cancel-1" as ActionId,
        wait: { timeoutMs: 1_000, expectation: null },
        action: "browser_close_tab",
        input: { tabId: victimId },
      },
      tabId: victimId,
    });
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) {
      throw new Error("unreachable");
    }

    // Wait until the removal call has actually gone out before cancelling.
    let spins = 0;
    while (h.controls.removeCalls.length === 0 && spins < 50) {
      await sleep(5);
      spins += 1;
    }
    expect(h.controls.removeCalls.length).toBe(1);

    const cancelReply = h.context.cancelAction("wait-cancel-1" as ActionId);
    expect(cancelReply).toMatchObject({ ok: true, cancelled: true, dispatchStarted: true });

    const result = await scheduled.settled;
    expect(result).toMatchObject({
      ok: false,
      error: { code: "action_cancelled", dispatchStarted: true },
    });
    expect(h.context.selectedTabId).toBe(victimId);
    expect(h.totalDisconnects()).toBe(0);

    h.controls.releaseHang();
    h.api.emitRemoved(victimId);
    expect(h.context.tabCount).toBe(1);
    expect(h.store.invalidatedTabs).toEqual([victimId]);
  });
});

describe("select inspection completion", () => {
  test("returns immediate completed evidence and permits repeat inspection", async () => {
    const TARGET: GroundedTarget = {
      tabId: 7,
      snapshotId: "snap-inspect" as GroundedTarget["snapshotId"],
      ref: 4,
    };
    const reads: GroundedTarget[] = [];
    const runtime = attachTabActionCoordinator({
      selectedTabId: 7,
      navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "unused" } }),
      goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "unused" } }),
      refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "unused" } }),
      click: async () => ({ ok: false, error: { code: "stale_ref", message: "unused", target: TARGET } }),
      type: async () => ({ ok: false, error: { code: "stale_ref", message: "unused" } }),
      clearInput: async () => ({ ok: false, error: { code: "stale_ref", message: "unused" } }),
      keypress: async () => ({ ok: false, error: { code: "stale_ref", message: "unused" } }),
      scroll: async () => ({ ok: false, error: { code: "stale_ref", message: "unused" } }),
      scrollToText: async () => ({ ok: false, error: { code: "stale_ref", message: "unused" } }),
      getSelectOptions: async (target) => {
        reads.push(target);
        return { ok: true, url: "https://example.com/final", options: [], optionsTruncated: false };
      },
      selectOption: async () => ({ ok: false, error: { code: "option_not_found", message: "unused" } }),
      openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "unused" } }),
      switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "unused" } }),
      closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "unused" } }),
      listTabs: async () => ({ ok: true, tabs: [] }),
      observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "unused" } }),
      useActiveTab: async () => ({ ok: true, tabId: 7 }),
    });

    const requestFor = (value: string): BrowserActionRequest =>
      ({
        type: BROWSER_ACTION_MESSAGE,
        actionId: value,
        action: "browser_get_select_options",
        input: TARGET,
      }) as BrowserActionRequest;

    const first = await handleBrowserRuntimeMessage(requestFor("read-1"), runtime);
    const second = await handleBrowserRuntimeMessage(requestFor("read-2"), runtime);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("unreachable");
    }
    expect(first.data).toMatchObject({ kind: "get_select_options", optionsTruncated: false });
    expect(lifecycleOf(first)).toEqual({
      actionId: "read-1",
      lifecycle: { status: "completed", completedBy: "read_only_inspection", elapsedMs: expect.any(Number) },
    });
    expect(lifecycleOf(second).actionId).toBe("read-2");
    expect(first.snapshotInvalidated).toBe(false);
    expect(second.snapshotInvalidated).toBe(false);
    expect(reads).toHaveLength(2);
    expect(reads[1]).toEqual(TARGET);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.parse(JSON.stringify(second))).toEqual(second);
  });
});
