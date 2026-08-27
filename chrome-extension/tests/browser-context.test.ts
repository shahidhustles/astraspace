import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserContext } from "../src/browser/context";
import type { PageDeps } from "../src/browser/page";
import { SnapshotStore } from "../src/browser/snapshot";
import type { DiagnosticEvent } from "../src/browser/types";

class SpyStore extends SnapshotStore {
  invalidatedTabs: number[] = [];

  invalidate(tabId: number): void {
    this.invalidatedTabs.push(tabId);
    super.invalidate(tabId);
  }
}

interface FakeBrowser extends Browser {
  disconnectCalls: number;
  connected: boolean;
}

interface FakePage extends Page {
  gotoCalls: number;
  goBackCalls: number;
  reloadCalls: number;
  currentUrl: string;
  gotoError: Error | null;
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
  const page = {
    gotoCalls: 0,
    goBackCalls: 0,
    reloadCalls: 0,
    currentUrl: "https://example.com",
    gotoError: null,
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
    goto: async (url: string) => {
      page.gotoCalls += 1;
      if (page.gotoError) {
        throw page.gotoError;
      }
      page.currentUrl = url;
      session?.emit("Page.frameNavigated", {
        frame: { id: "main-1", loaderId: `L${page.gotoCalls + 1}`, url },
        type: "Navigation",
      });
      return {};
    },
    goBack: async () => {
      page.goBackCalls += 1;
      session?.emit("Page.navigatedWithinDocument", { frameId: "main-1", url: page.currentUrl });
      return {};
    },
    reload: async () => {
      page.reloadCalls += 1;
      session?.emit("Page.frameNavigated", {
        frame: { id: "main-1", loaderId: `L-r${page.reloadCalls}`, url: page.currentUrl },
        type: "Navigation",
      });
      return {};
    },
    url: () => page.currentUrl,
  } as FakePage;
  return page;
}

function fakeBrowser(page: FakePage = fakePage()): FakeBrowser {
  const browser = {
    connected: true,
    disconnectCalls: 0,
    pages: async () => [page],
    disconnect: async () => {
      browser.disconnectCalls += 1;
    },
  } as FakeBrowser;
  return browser;
}

interface FakeEvents {
  emitUpdated(tab: chrome.tabs.Tab): void;
  emitActivated(tabId: number): void;
  emitRemoved(tabId: number): void;
  emitDetached(tabId: number): void;
  updatedListenerCount: () => number;
  activatedListenerCount: () => number;
  removedListenerCount: () => number;
  detachedListenerCount: () => number;
}

interface FakeDeps {
  context: BrowserContext;
  events: DiagnosticEvent[];
  connectTabCalls: () => number;
  removeTabCalls: () => number[];
  browsers: FakeBrowser[];
  api: FakeEvents;
  page: FakePage;
  snapshotStore: SpyStore;
}

function setup(overrides: {
  tabs?: chrome.tabs.Tab[];
  allTabs?: chrome.tabs.Tab[];
  connectTab?: PageDeps["connectTab"];
  connect?: PageDeps["connect"];
  createTab?: (url: string) => Promise<chrome.tabs.Tab>;
  updateTab?: (tabId: number) => Promise<chrome.tabs.Tab>;
  removeTab?: (tabId: number) => Promise<void>;
  timeoutMs?: number;
  snapshotStore?: SnapshotStore;
} = {}): FakeDeps {
  let connectTabCalls = 0;
  const page = fakePage();
  const browsers: FakeBrowser[] = [];
  const removedTabIds: number[] = [];
  const events: DiagnosticEvent[] = [];
  const updatedListeners = new Set<
    (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
  >();
  const activatedListeners = new Set<(info: chrome.tabs.OnActivatedInfo) => void>();
  const removedListeners = new Set<(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void>();
  const detachedListeners = new Set<(source: chrome.debugger.Debuggee, reason: string) => void>();

  const pageDeps: PageDeps = {
    connect: async () => {
      const browser = fakeBrowser(page);
      browsers.push(browser);
      return browser;
    },
    connectTab: async () => {
      connectTabCalls += 1;
      return {} as never;
    },
    timeoutMs: 100,
    settleTimings: { domQuietMs: 1, networkQuietMs: 1, pollMs: 1 },
    ...overrides,
  };
  const snapshotStore = overrides.snapshotStore ?? new SpyStore();
  pageDeps.snapshotStore = snapshotStore;

  const context = new BrowserContext({
    queryActiveTab: async () => overrides.tabs ?? [],
    queryTabs: async () => overrides.allTabs ?? [],
    createTab: overrides.createTab ?? (async (url) => ({ id: 42, url }) as chrome.tabs.Tab),
    updateTab: overrides.updateTab ?? (async (tabId) => ({ id: tabId, url: "https://example.com" }) as chrome.tabs.Tab),
    removeTab: overrides.removeTab ?? (async (tabId) => {
      removedTabIds.push(tabId);
    }),
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
    diagnostics: (event) => events.push(event),
    pageDeps,
    timeoutMs: overrides.timeoutMs ?? 50,
  });

  const api: FakeEvents = {
    emitUpdated: (tab) => {
      for (const listener of updatedListeners) {
        listener(tab.id ?? 0, {}, tab);
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
    emitDetached: (tabId) => {
      for (const listener of detachedListeners) {
        listener({ tabId }, "target_closed");
      }
    },
    updatedListenerCount: () => updatedListeners.size,
    activatedListenerCount: () => activatedListeners.size,
    removedListenerCount: () => removedListeners.size,
    detachedListenerCount: () => detachedListeners.size,
  };

  return { context, events, connectTabCalls: () => connectTabCalls, removeTabCalls: () => removedTabIds, browsers, api, page, snapshotStore };
}

function activeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab[] {
  return [{ id: 7, url: "https://example.com", ...overrides } as chrome.tabs.Tab];
}

// Full successful open/switch/close results now carry lifecycle measurement,
// so exact expectations build it in one place.
function tabResult(
  tabId: number,
  completedBy: "controllable_url_and_attach" | "activation_and_attach" | "removal_confirmed",
): { ok: boolean; tabId: number; measured: unknown } {
  return {
    ok: true,
    tabId,
    measured: {
      actionId: expect.any(String),
      lifecycle: { status: "completed", completedBy, elapsedMs: expect.any(Number) },
    },
  };
}

describe("BrowserContext", () => {
  test("selects an active allowed tab and registers it once", async () => {
    const { context, events } = setup({ tabs: activeTab() });

    const result = await context.useActiveTab();

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(context.selectedTabId).toBe(7);
    expect(context.tabCount).toBe(1);
    expect(events).toEqual([
      { type: "attach_started", tabId: 7 },
      { type: "attach_ok", tabId: 7 },
    ]);
  });

  test("reuses the live connection on repeated requests", async () => {
    const { context, events, connectTabCalls } = setup({ tabs: activeTab() });

    await context.useActiveTab();
    await context.useActiveTab();
    const result = await context.useActiveTab();

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(connectTabCalls()).toBe(1);
    expect(context.tabCount).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "attach_started",
      "attach_ok",
      "attach_reused",
      "attach_reused",
    ]);
  });

  test("two concurrent requests create a single transport", async () => {
    let releaseConnectTab: (() => void) | null = null;
    let connectTabCalls = 0;
    const { context } = setup({
      tabs: activeTab(),
      connectTab: async () => {
        connectTabCalls += 1;
        await new Promise<void>((resolve) => {
          releaseConnectTab = resolve;
        });
        return {} as never;
      },
    });

    const first = context.useActiveTab();
    const second = context.useActiveTab();
    await Promise.resolve();
    await Promise.resolve();
    releaseConnectTab?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ ok: true, tabId: 7 });
    expect(secondResult).toEqual({ ok: true, tabId: 7 });
    expect(connectTabCalls).toBe(1);
    expect(context.tabCount).toBe(1);
  });

  test("returns active_tab_unavailable when no tab is active", async () => {
    const { context, events } = setup({ tabs: [] });

    const result = await context.useActiveTab();

    expect(result).toEqual({
      ok: false,
      error: { code: "active_tab_unavailable", message: "No controllable active tab" },
    });
    expect(context.selectedTabId).toBeNull();
    expect(context.tabCount).toBe(0);
    expect(events).toEqual([]);
  });

  test("returns active_tab_unavailable when the tab has no id", async () => {
    const { context } = setup({ tabs: activeTab({ id: undefined }) });

    const result = await context.useActiveTab();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("active_tab_unavailable");
  });

  test("returns inaccessible_tab when the active tab URL is not exposed", async () => {
    const { context, connectTabCalls } = setup({ tabs: activeTab({ url: undefined }) });

    const result = await context.useActiveTab();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("inaccessible_tab");
    expect(connectTabCalls()).toBe(0);
  });

  test("returns the policy error for an unsupported active tab", async () => {
    const { context, connectTabCalls } = setup({ tabs: activeTab({ url: "chrome://newtab" }) });

    const result = await context.useActiveTab();

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(connectTabCalls()).toBe(0);
    expect(context.selectedTabId).toBeNull();
  });

  test("returns attach_conflict when another debugger owns the tab", async () => {
    const { context } = setup({
      tabs: activeTab(),
      connectTab: async () => {
        throw new Error("Another debugger is already attached to the tab with id: 7");
      },
    });

    const result = await context.useActiveTab();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("attach_conflict");
  });

  test("returns attach_failed for other transport failures", async () => {
    const { context } = setup({
      tabs: activeTab(),
      connectTab: async () => {
        throw new Error("tab not debuggable");
      },
    });

    const result = await context.useActiveTab();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("attach_failed");
  });

  test("can retry after a failed attach without a new registry entry", async () => {
    let fail = true;
    const { context, events } = setup({
      tabs: activeTab(),
      connectTab: async () => {
        if (fail) {
          throw new Error("tab not debuggable");
        }
        return {} as never;
      },
    });

    const first = await context.useActiveTab();
    fail = false;
    const second = await context.useActiveTab();

    expect(first.ok).toBe(false);
    expect(second).toEqual({ ok: true, tabId: 7 });
    expect(context.tabCount).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["attach_started", "attach_failed", "attach_started", "attach_ok"]);
  });

  test("bounds a stalled tab attachment and leaves no selected connection", async () => {
    const { context, events } = setup({
      tabs: activeTab(),
      timeoutMs: 10,
      connectTab: () => new Promise(() => {}),
    });

    const result = await context.useActiveTab();

    expect(result).toEqual({
      ok: false,
      error: { code: "lifecycle_timeout", message: "Tab attachment timed out" },
    });
    expect(context.selectedTabId).toBeNull();
    expect(events).toContainEqual({ type: "attach_failed", tabId: 7, code: "lifecycle_timeout" });
  });

  test("diagnostics never record page content or URL credentials", async () => {
    const { context, events } = setup({ tabs: activeTab({ url: "https://user:secret@example.com/path" }) });

    await context.useActiveTab();

    expect(JSON.stringify(events)).not.toContain("user:secret");
    expect(JSON.stringify(events)).not.toContain("example.com");
  });

  test("listTabs reports controllable tabs and selected state without attaching", async () => {
    const { context, connectTabCalls } = setup({
      tabs: activeTab(),
      allTabs: [
        { id: 7, url: "https://example.com", title: "One" } as chrome.tabs.Tab,
        { id: 8, url: "https://other.com", title: "Two" } as chrome.tabs.Tab,
        { id: 9, url: "chrome://newtab", title: "New Tab" } as chrome.tabs.Tab,
      ],
    });
    await context.useActiveTab();

    const result = await context.listTabs();

    expect(result).toEqual({
      ok: true,
      tabs: [
        { tabId: 7, url: "https://example.com", title: "One", attached: true, selected: true },
        { tabId: 8, url: "https://other.com", title: "Two", attached: false, selected: false },
      ],
    });
    expect(connectTabCalls()).toBe(1);
  });

  test("openTab creates a tab, waits for its URL, and attaches it", async () => {
    const { context, api } = setup({
      createTab: async () => ({ id: 42, url: "about:blank" }) as chrome.tabs.Tab,
    });

    const pending = context.openTab("https://example.com/start");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://example.com/start" });

    expect(await pending).toEqual(tabResult(42, "controllable_url_and_attach"));
    expect(context.selectedTabId).toBe(42);
    expect(context.tabCount).toBe(1);
  });

  test("openTab attaches when the created tab already has a controllable URL", async () => {
    const { context, connectTabCalls } = setup({
      createTab: async (url) => ({ id: 42, status: "complete", url }) as chrome.tabs.Tab,
      timeoutMs: 10,
    });

    const result = await context.openTab("https://example.com/ready");

    expect(result).toEqual(tabResult(42, "controllable_url_and_attach"));
    expect(connectTabCalls()).toBe(1);
  });

  test("openTab catches a controllable URL emitted before tab creation resolves", async () => {
    let emitUpdated = (): void => {};
    const { context, api } = setup({
      createTab: async () => {
        emitUpdated();
        return { id: 42, url: "about:blank" } as chrome.tabs.Tab;
      },
      timeoutMs: 20,
    });
    emitUpdated = () => api.emitUpdated({ id: 42, url: "https://example.com/ready" } as chrome.tabs.Tab);

    const result = await context.openTab("https://example.com/ready");

    expect(result).toEqual(tabResult(42, "controllable_url_and_attach"));
    expect(api.updatedListenerCount()).toBe(0);
  });

  test("openTab rejects a blocked URL without creating a tab", async () => {
    let createCalls = 0;
    const { context } = setup({
      createTab: async (url) => {
        createCalls += 1;
        return { id: 42, url } as chrome.tabs.Tab;
      },
    });

    const result = await context.openTab("chrome://newtab");

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(createCalls).toBe(0);
  });

  test("openTab times out when the tab never reaches a controllable URL and keeps the previous selection", async () => {
    const { context, api } = setup({
      tabs: activeTab(),
      createTab: async () => ({ id: 42, url: "about:blank" }) as chrome.tabs.Tab,
      timeoutMs: 30,
    });
    await context.useActiveTab();

    const result = await context.openTab("https://example.com/slow");

    expect(result).toEqual({
      ok: false,
      error: { code: "lifecycle_timeout", message: "Tab did not reach a controllable URL" },
    });
    expect(context.selectedTabId).toBe(7);
    expect(api.updatedListenerCount()).toBe(0);
  });

  test("openTab returns chrome_api_error when tab creation fails", async () => {
    const { context } = setup({
      createTab: async () => {
        throw new Error("boom");
      },
    });

    const result = await context.openTab("https://example.com");

    expect(result).toEqual({ ok: false, error: { code: "chrome_api_error", message: "Could not create tab" } });
    expect(context.selectedTabId).toBeNull();
  });

  test("switchTab reuses the connection of a known attached tab", async () => {
    const { context, api, connectTabCalls, events } = setup({ tabs: activeTab() });
    await context.useActiveTab();
    events.length = 0;

    const pending = context.switchTab(7);
    await Promise.resolve();
    await Promise.resolve();
    api.emitActivated(7);

    expect(await pending).toEqual(tabResult(7, "activation_and_attach"));
    expect(connectTabCalls()).toBe(1);
    expect(events).toEqual([{ type: "attach_reused", tabId: 7 }]);
  });

  test("switchTab succeeds when Chrome reports the tab is already active", async () => {
    const { context, api } = setup({
      tabs: activeTab(),
      updateTab: async (tabId) => ({ id: tabId, active: true, url: "https://example.com" }) as chrome.tabs.Tab,
      timeoutMs: 20,
    });
    await context.useActiveTab();

    const result = await context.switchTab(7);

    expect(result).toEqual(tabResult(7, "activation_and_attach"));
    expect(api.activatedListenerCount()).toBe(0);
  });

  test("switchTab attaches a registered tab whose earlier attach failed", async () => {
    let fail = true;
    const { context, api } = setup({
      connectTab: async () => {
        if (fail) {
          throw new Error("tab not debuggable");
        }
        return {} as never;
      },
    });

    const opened = context.openTab("https://example.com/start");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://example.com/start" });
    expect((await opened).ok).toBe(false);

    fail = false;
    const switched = context.switchTab(42);
    await Promise.resolve();
    await Promise.resolve();
    api.emitActivated(42);

    expect(await switched).toEqual(tabResult(42, "activation_and_attach"));
    expect(context.selectedTabId).toBe(42);
    expect(context.tabCount).toBe(1);
  });

  test("openTab creates two independent connections for two tabs", async () => {
    let nextId = 10;
    const { context, api, connectTabCalls } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });

    expect(await first).toEqual(tabResult(10, "controllable_url_and_attach"));
    expect(await second).toEqual(tabResult(11, "controllable_url_and_attach"));
    expect(context.tabCount).toBe(2);
    expect(connectTabCalls()).toBe(2);
    expect(context.selectedTabId).toBe(11);
  });

  test("switching between two opened tabs changes selection and reuses both connections", async () => {
    let nextId = 10;
    const { context, api, connectTabCalls } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    const pending = context.switchTab(10);
    await Promise.resolve();
    await Promise.resolve();
    api.emitActivated(10);

    expect(await pending).toEqual(tabResult(10, "activation_and_attach"));
    expect(context.selectedTabId).toBe(10);
    expect(connectTabCalls()).toBe(2);
    expect(context.tabCount).toBe(2);
  });

  test("switchTab returns missing_tab for an unknown tab and leaves no listener", async () => {
    const { context, api } = setup({
      tabs: activeTab(),
      updateTab: async () => {
        throw new Error("No tab with id: 55");
      },
    });
    await context.useActiveTab();

    const result = await context.switchTab(55);

    expect(result).toEqual({ ok: false, error: { code: "missing_tab", message: "No such tab" } });
    expect(context.selectedTabId).toBe(7);
    expect(api.activatedListenerCount()).toBe(0);
  });

  test("switchTab attaches a tab that is not yet registered", async () => {
    const { context, api } = setup({
      updateTab: async (tabId) => ({ id: tabId, url: "https://example.org" }) as chrome.tabs.Tab,
    });

    const pending = context.switchTab(33);
    await Promise.resolve();
    await Promise.resolve();
    api.emitActivated(33);

    expect(await pending).toEqual(tabResult(33, "activation_and_attach"));
    expect(context.selectedTabId).toBe(33);
    expect(context.tabCount).toBe(1);
  });

  test("switchTab times out when activation never fires and keeps the previous selection", async () => {
    const { context, api } = setup({ tabs: activeTab(), timeoutMs: 30 });
    await context.useActiveTab();

    const result = await context.switchTab(7);

    expect(result).toEqual({ ok: false, error: { code: "lifecycle_timeout", message: "Tab did not activate" } });
    expect(context.selectedTabId).toBe(7);
    expect(api.activatedListenerCount()).toBe(0);
  });

  test("switchTab rejects an unsupported tab URL", async () => {
    const { context, api } = setup({
      updateTab: async (tabId) => ({ id: tabId, url: "chrome://newtab" }) as chrome.tabs.Tab,
    });

    const pending = context.switchTab(33);
    await Promise.resolve();
    await Promise.resolve();
    api.emitActivated(33);

    expect(await pending).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
  });

  test("navigate returns selected_tab_unavailable when nothing is selected", async () => {
    const { context } = setup({});

    const result = await context.navigate("https://example.com/target");

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("navigate changes the selected tab to an allowed destination", async () => {
    const { context, page } = setup({ tabs: activeTab() });
    await context.useActiveTab();
    page.currentUrl = "https://example.com/target";

    const result = await context.navigate("https://example.com/target");

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        url: "https://example.com/target",
        commitType: "commit",
      }),
    );
    expect(page.gotoCalls).toBe(1);
    expect(context.selectedTabId).toBe(7);
  });

  test("navigate rejects a blocked destination without touching selection or connections", async () => {
    const { context, page } = setup({ tabs: activeTab() });
    await context.useActiveTab();

    const result = await context.navigate("chrome://newtab");

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(page.gotoCalls).toBe(0);
    expect(context.selectedTabId).toBe(7);
    expect(context.tabCount).toBe(1);
  });

  test("navigate failure keeps the selection and other tab connections intact", async () => {
    let nextId = 10;
    const { context, api, page } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    page.gotoError = new Error("net::ERR_INTERNET_DISCONNECTED");
    const result = await context.navigate("https://c.example");

    expect(result).toEqual({ ok: false, error: { code: "navigation_failed", message: "Navigation failed" } });
    expect(context.selectedTabId).toBe(11);
    expect(context.tabCount).toBe(2);
  });

  test("goBack returns the selected tab to its previous history entry", async () => {
    const { context, page } = setup({ tabs: activeTab() });
    await context.useActiveTab();
    page.currentUrl = "https://example.com/start";

    const result = await context.goBack();

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        url: "https://example.com/start",
        commitType: "same_document",
      }),
    );
    expect(page.goBackCalls).toBe(1);
  });

  test("goBack returns selected_tab_unavailable when nothing is selected", async () => {
    const { context } = setup({});

    const result = await context.goBack();

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("refresh reloads the selected tab", async () => {
    const { context, page } = setup({ tabs: activeTab() });
    await context.useActiveTab();

    const result = await context.refresh();

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        url: "https://example.com",
        commitType: "commit",
      }),
    );
    expect(page.reloadCalls).toBe(1);
  });

  test("refresh returns selected_tab_unavailable when nothing is selected", async () => {
    const { context } = setup({});

    const result = await context.refresh();

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("closeTab disconnects and removes only the requested tab", async () => {
    let nextId = 10;
    const { context, api, browsers, removeTabCalls } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    const result = await context.closeTab(10);

    expect(result).toEqual(tabResult(10, "removal_confirmed"));
    expect(removeTabCalls()).toEqual([10]);
    expect(browsers[0].disconnectCalls).toBe(1);
    expect(browsers[1].disconnectCalls).toBe(0);
    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBe(11);
  });

  test("closeTab clears the selection when the selected tab is closed", async () => {
    const { context, api } = setup({ tabs: activeTab() });
    await context.useActiveTab();

    const result = await context.closeTab(7);

    expect(result).toEqual(tabResult(7, "removal_confirmed"));
    expect(context.selectedTabId).toBeNull();
    expect(context.tabCount).toBe(0);
  });

  test("closeTab returns missing_tab for an unmanaged tab", async () => {
    const { context, removeTabCalls } = setup({});

    const result = await context.closeTab(99);

    expect(result).toEqual({ ok: false, error: { code: "missing_tab", message: "No such tab" } });
    expect(removeTabCalls()).toEqual([]);
  });

  test("closeTab returns missing_tab when Chrome reports an unknown tab", async () => {
    const { context, api } = setup({
      tabs: activeTab(),
      removeTab: async () => {
        throw new Error("No tab with id: 7");
      },
    });
    await context.useActiveTab();

    const result = await context.closeTab(7);

    expect(result).toEqual({ ok: false, error: { code: "missing_tab", message: "No such tab" } });
    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBe(7);
  });

  test("closeTab preserves the live connection when Chrome cannot remove the tab", async () => {
    const { context } = setup({
      tabs: activeTab(),
      removeTab: async () => {
        throw new Error("Tab is busy");
      },
    });
    await context.useActiveTab();

    const result = await context.closeTab(7);

    expect(result).toEqual({
      ok: false,
      error: { code: "chrome_api_error", message: "Could not close tab" },
    });
    expect(context.selectedTabId).toBe(7);
    expect(context.tabCount).toBe(1);
  });

  test("closeTab reports a disconnect failure but still removes the tab", async () => {
    let nextId = 10;
    const { context, api, browsers, removeTabCalls } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const pending = context.openTab("https://a.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    await pending;

    const failingBrowser = browsers[0];
    const originalDisconnect = failingBrowser.disconnect.bind(failingBrowser);
    failingBrowser.disconnect = async () => {
      await originalDisconnect();
      throw new Error("connection lost");
    };

    const result = await context.closeTab(10);

    expect(result).toEqual({
      ok: false,
      error: { code: "disconnect_failed", message: "Failed to disconnect from tab" },
    });
    expect(removeTabCalls()).toEqual([10]);
    expect(context.tabCount).toBe(0);
  });

  test("a tab-removal event removes the connection and clears selection only for the selected tab", async () => {
    let nextId = 10;
    const { context, api, browsers } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    api.emitRemoved(10);
    api.emitRemoved(10);

    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBe(11);
    expect(browsers[0].disconnectCalls).toBe(1);

    api.emitRemoved(11);

    expect(context.tabCount).toBe(0);
    expect(context.selectedTabId).toBeNull();
    expect(browsers[1].disconnectCalls).toBe(1);
  });

  test("a debugger detach removes only the named connection and allows reattach", async () => {
    let nextId = 10;
    const { context, api, connectTabCalls, browsers } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    api.emitDetached(10);

    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBe(11);
    expect(connectTabCalls()).toBe(2);
    expect(browsers[0].disconnectCalls).toBe(1);

    const reopened = context.openTab("https://a.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 12, url: "https://a.example" });

    expect(await reopened).toEqual(tabResult(12, "controllable_url_and_attach"));
    expect(connectTabCalls()).toBe(3);
  });

  test("cleanup disconnects every tab, removes listeners, and empties the registry", async () => {
    let nextId = 10;
    const { context, api, browsers } = setup({
      createTab: async (url) => ({ id: nextId++, url }) as chrome.tabs.Tab,
    });

    const first = context.openTab("https://a.example");
    const second = context.openTab("https://b.example");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 10, url: "https://a.example" });
    api.emitUpdated({ id: 11, url: "https://b.example" });
    await Promise.all([first, second]);

    const result = await context.cleanup();
    const secondResult = await context.cleanup();

    expect(result).toEqual({ failures: [] });
    expect(secondResult).toEqual({ failures: [] });
    expect(browsers[0].disconnectCalls).toBe(1);
    expect(browsers[1].disconnectCalls).toBe(1);
    expect(context.tabCount).toBe(0);
    expect(context.selectedTabId).toBeNull();
    expect(api.removedListenerCount()).toBe(0);
    expect(api.detachedListenerCount()).toBe(0);
  });

  test("cleanup reports disconnect failures and still empties the registry", async () => {
    const { context, browsers } = setup({ tabs: activeTab() });
    await context.useActiveTab();
    const failingBrowser = browsers[0];
    failingBrowser.disconnect = async () => {
      throw new Error("connection lost");
    };

    const result = await context.cleanup();

    expect(result).toEqual({
      failures: [{ code: "disconnect_failed", message: "Failed to disconnect from tab" }],
    });
    expect(context.tabCount).toBe(0);
    expect(context.selectedTabId).toBeNull();
  });

  test("switching between tabs never invalidates snapshot state", async () => {
    const { context, snapshotStore, api } = setup({
      tabs: activeTab(),
      createTab: async (url) => ({ id: 42, url }) as chrome.tabs.Tab,
    });
    await context.useActiveTab();
    const opened = context.openTab("https://b.example");
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://b.example" });
    expect((await opened).ok).toBe(true);

    const first = context.switchTab(42);
    await Promise.resolve();
    api.emitActivated(42);
    expect(await first).toEqual(tabResult(42, "activation_and_attach"));
    const second = context.switchTab(7);
    await Promise.resolve();
    api.emitActivated(7);
    expect(await second).toEqual(tabResult(7, "activation_and_attach"));

    expect(snapshotStore.invalidatedTabs).toEqual([]);
    expect(context.selectedTabId).toBe(7);
  });

  test("closeTab invalidates only the closed tab's snapshot state", async () => {
    const { context, snapshotStore, api } = setup({
      tabs: activeTab(),
      createTab: async (url) => ({ id: 42, url }) as chrome.tabs.Tab,
    });
    await context.useActiveTab();
    const opened = context.openTab("https://b.example");
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://b.example" });
    expect((await opened).ok).toBe(true);

    await context.closeTab(42);

    expect(snapshotStore.invalidatedTabs).toEqual([42]);
    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBeNull();
  });

  test("a tab-removal event invalidates only the removed tab's snapshot state", async () => {
    const { context, snapshotStore, api } = setup({
      tabs: activeTab(),
      createTab: async (url) => ({ id: 42, url }) as chrome.tabs.Tab,
    });
    await context.useActiveTab();
    const opened = context.openTab("https://b.example");
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://b.example" });
    expect((await opened).ok).toBe(true);

    api.emitRemoved(42);

    expect(snapshotStore.invalidatedTabs).toEqual([42]);
    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBeNull();
  });

  test("a debugger detach invalidates only the detached tab's snapshot state", async () => {
    const { context, snapshotStore, api } = setup({
      tabs: activeTab(),
      createTab: async (url) => ({ id: 42, url }) as chrome.tabs.Tab,
    });
    await context.useActiveTab();
    const opened = context.openTab("https://b.example");
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://b.example" });
    expect((await opened).ok).toBe(true);

    api.emitDetached(42);

    expect(snapshotStore.invalidatedTabs).toEqual([42]);
    expect(context.tabCount).toBe(1);
    expect(context.selectedTabId).toBeNull();
  });
});
