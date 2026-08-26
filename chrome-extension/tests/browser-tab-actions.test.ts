import { describe, expect, test } from "bun:test";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { TabInfo } from "../src/browser/types";

const TABS: TabInfo[] = [
  { tabId: 1, url: "https://example.com", title: "Example", attached: true, selected: false },
  { tabId: 9, url: "https://opened.example", title: "Opened", attached: true, selected: true },
];

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    selectedTabId: 9,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    click: async () => ({ ok: false, error: { code: "stale_ref", message: "not used", target: { tabId: 7, snapshotId: "s" as const, ref: 1 } } }),
    openTab: async () => ({ ok: true, tabId: 9 }),
    switchTab: async () => ({ ok: true, tabId: 9 }),
    closeTab: async () => ({ ok: true, tabId: 9 }),
    listTabs: async () => ({ ok: true, tabs: TABS }),
    ...overrides,
  };
}

describe("browser_open_tab", () => {
  test("opens a tab and returns the selected tab with filtered tab state", async () => {
    let openedUrl: string | null = null;
    const runtime = fakeRuntime({
      openTab: async (url) => {
        openedUrl = url;
        return { ok: true, tabId: 9 };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: "https://opened.example" } },
      runtime,
    );

    expect(openedUrl).toBe("https://opened.example");
    expect(result).toEqual({
      ok: true,
      action: "browser_open_tab",
      tabId: 9,
      url: "https://opened.example",
      snapshotInvalidated: true,
      data: { kind: "open_tab", tabs: TABS },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("falls back to the requested url when the tab is not listed", async () => {
    const runtime = fakeRuntime({
      listTabs: async () => ({ ok: true, tabs: TABS.filter((tab) => tab.tabId !== 9) }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: "https://opened.example" } },
      runtime,
    );

    expect(result).toMatchObject({ ok: true, url: "https://opened.example" });
    if (result?.ok) {
      expect(result.data).toEqual({ kind: "open_tab", tabs: [TABS[0]] });
    }
  });

  test("reports null tab state when the tab list is unavailable", async () => {
    const runtime = fakeRuntime({
      listTabs: async () => ({ ok: false, error: { code: "chrome_api_error", message: "could not list" } }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: "https://opened.example" } },
      runtime,
    );

    expect(result).toEqual({
      ok: true,
      action: "browser_open_tab",
      tabId: 9,
      url: "https://opened.example",
      snapshotInvalidated: true,
      data: { kind: "open_tab", tabs: null },
    });
  });

  test("preserves URL-policy failures", async () => {
    const runtime = fakeRuntime({
      openTab: async () => ({
        ok: false,
        error: { code: "url_denied", message: "Blocked URL scheme: chrome-extension:", url: "chrome-extension://x" },
      }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: "chrome-extension://x" } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_open_tab",
      tabId: 9,
      error: { code: "url_denied", message: "Blocked URL scheme: chrome-extension:", url: "chrome-extension://x" },
    });
  });

  test("rejects a malformed open request", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: {} },
      runtime,
    );
    expect(result).toEqual({
      ok: false,
      action: "browser_open_tab",
      tabId: null,
      error: { code: "invalid_action", message: "browser_open_tab requires a string url" },
    });
  });
});

describe("browser_switch_tab", () => {
  test("switches to the requested tab and returns the selected tab state", async () => {
    let switchedId: number | null = null;
    const runtime = fakeRuntime({
      switchTab: async (tabId) => {
        switchedId = tabId;
        return { ok: true, tabId };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_switch_tab", input: { tabId: 9 } },
      runtime,
    );

    expect(switchedId).toBe(9);
    expect(result).toEqual({
      ok: true,
      action: "browser_switch_tab",
      tabId: 9,
      url: "https://opened.example",
      snapshotInvalidated: true,
      data: { kind: "switch_tab", tabs: TABS },
    });
  });

  test("preserves missing-tab failures", async () => {
    const runtime = fakeRuntime({
      switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "No such tab" } }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_switch_tab", input: { tabId: 404 } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_switch_tab",
      tabId: 9,
      error: { code: "missing_tab", message: "No such tab" },
    });
  });

  test("rejects a malformed switch request", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_switch_tab", input: { tabId: 4.5 } },
      runtime,
    );
    expect(result).toEqual({
      ok: false,
      action: "browser_switch_tab",
      tabId: null,
      error: { code: "invalid_action", message: "browser_switch_tab requires an integer tabId" },
    });
  });
});

describe("browser_close_tab", () => {
  test("closes the requested tab and returns the remaining tab state", async () => {
    let closedId: number | null = null;
    const runtime = fakeRuntime({
      closeTab: async (tabId) => {
        closedId = tabId;
        return { ok: true, tabId };
      },
      listTabs: async () => ({ ok: true, tabs: TABS.filter((tab) => tab.tabId !== 9) }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_close_tab", input: { tabId: 9 } },
      runtime,
    );

    expect(closedId).toBe(9);
    expect(result).toEqual({
      ok: true,
      action: "browser_close_tab",
      tabId: 9,
      url: "",
      snapshotInvalidated: true,
      data: { kind: "close_tab", tabs: [TABS[0]] },
    });
  });

  test("preserves missing-tab failures", async () => {
    const runtime = fakeRuntime({
      closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "No such tab" } }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_close_tab", input: { tabId: 404 } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_close_tab",
      tabId: 9,
      error: { code: "missing_tab", message: "No such tab" },
    });
  });

  test("rejects unknown fields on the close request", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_close_tab", input: { tabId: 9, force: true } },
      runtime,
    );
    expect(result).toEqual({
      ok: false,
      action: "browser_close_tab",
      tabId: null,
      error: { code: "invalid_action", message: "browser_close_tab input has unknown fields" },
    });
  });
});