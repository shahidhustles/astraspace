import { describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserContext } from "../src/browser/context";
import type { PageDeps } from "../src/browser/page";
import type { DiagnosticEvent } from "../src/browser/types";

interface FakeBrowser extends Browser {
  disconnectCalls: number;
}

function fakeBrowser(): FakeBrowser {
  const browser = {
    disconnectCalls: 0,
    pages: async () => [{ id: "page-1" } as Page],
    disconnect: async () => {
      browser.disconnectCalls += 1;
    },
  } as FakeBrowser;
  return browser;
}

interface FakeDeps {
  context: BrowserContext;
  events: DiagnosticEvent[];
  connectTabCalls: () => number;
}

function setup(overrides: {
  tabs?: chrome.tabs.Tab[];
  connectTab?: PageDeps["connectTab"];
  connect?: PageDeps["connect"];
} = {}): FakeDeps {
  let connectTabCalls = 0;
  const browser = fakeBrowser();
  const events: DiagnosticEvent[] = [];
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
    diagnostics: (event) => events.push(event),
    pageDeps,
  });
  return { context, events, connectTabCalls: () => connectTabCalls };
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
});