import { describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserContext } from "../src/browser/context";
import type { PageDeps } from "../src/browser/page";
import type { DiagnosticEvent } from "../src/browser/types";

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

function fakePage(): FakePage {
  const page = {
    gotoCalls: 0,
    goBackCalls: 0,
    reloadCalls: 0,
    currentUrl: "https://example.com",
    gotoError: null,
    goto: async () => {
      page.gotoCalls += 1;
      if (page.gotoError) {
        throw page.gotoError;
      }
      return {};
    },
    goBack: async () => {
      page.goBackCalls += 1;
      return {};
    },
    reload: async () => {
      page.reloadCalls += 1;
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
  updatedListenerCount: () => number;
  activatedListenerCount: () => number;
}

interface FakeDeps {
  context: BrowserContext;
  events: DiagnosticEvent[];
  connectTabCalls: () => number;
  api: FakeEvents;
  page: FakePage;
}

function setup(overrides: {
  tabs?: chrome.tabs.Tab[];
  allTabs?: chrome.tabs.Tab[];
  connectTab?: PageDeps["connectTab"];
  connect?: PageDeps["connect"];
  createTab?: (url: string) => Promise<chrome.tabs.Tab>;
  updateTab?: (tabId: number) => Promise<chrome.tabs.Tab>;
  timeoutMs?: number;
} = {}): FakeDeps {
  let connectTabCalls = 0;
  const page = fakePage();
  const browser = fakeBrowser(page);
  const events: DiagnosticEvent[] = [];
  const updatedListeners = new Set<
    (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void
  >();
  const activatedListeners = new Set<(info: chrome.tabs.OnActivatedInfo) => void>();

  const pageDeps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      connectTabCalls += 1;
      return {} as never;
    },
    ...overrides,
  };

  const context = new BrowserContext({
    queryActiveTab: async () => overrides.tabs ?? [],
    queryTabs: async () => overrides.allTabs ?? [],
    createTab: overrides.createTab ?? (async (url) => ({ id: 42, url }) as chrome.tabs.Tab),
    updateTab: overrides.updateTab ?? (async (tabId) => ({ id: tabId, url: "https://example.com" }) as chrome.tabs.Tab),
    onUpdated: (listener) => {
      updatedListeners.add(listener);
      return () => updatedListeners.delete(listener);
    },
    onActivated: (listener) => {
      activatedListeners.add(listener);
      return () => activatedListeners.delete(listener);
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
    updatedListenerCount: () => updatedListeners.size,
    activatedListenerCount: () => activatedListeners.size,
  };

  return { context, events, connectTabCalls: () => connectTabCalls, api, page };
}

function activeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab[] {
  return [{ id: 7, url: "https://example.com", ...overrides } as chrome.tabs.Tab];
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
    const { context, api } = setup({});

    const pending = context.openTab("https://example.com/start");
    await Promise.resolve();
    await Promise.resolve();
    api.emitUpdated({ id: 42, url: "https://example.com/start" });

    expect(await pending).toEqual({ ok: true, tabId: 42 });
    expect(context.selectedTabId).toBe(42);
    expect(context.tabCount).toBe(1);
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
    const { context, api } = setup({ tabs: activeTab(), timeoutMs: 30 });
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

    expect(await pending).toEqual({ ok: true, tabId: 7 });
    expect(connectTabCalls()).toBe(1);
    expect(events).toEqual([{ type: "attach_reused", tabId: 7 }]);
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

    expect(await switched).toEqual({ ok: true, tabId: 42 });
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

    expect(await first).toEqual({ ok: true, tabId: 10 });
    expect(await second).toEqual({ ok: true, tabId: 11 });
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

    expect(await pending).toEqual({ ok: true, tabId: 10 });
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

    expect(await pending).toEqual({ ok: true, tabId: 33 });
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

    expect(result).toEqual({ ok: true, url: "https://example.com/target" });
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

    expect(result).toEqual({ ok: true, url: "https://example.com/start" });
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

    expect(result).toEqual({ ok: true, url: "https://example.com" });
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
});