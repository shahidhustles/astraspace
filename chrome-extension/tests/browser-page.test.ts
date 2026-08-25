import { describe, expect, test } from "bun:test";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserPage, type PageDeps } from "../src/browser/page";

interface FakeBrowser extends Browser {
  pagesCalls: number;
  disconnectCalls: number;
  closeCalls: number;
}

function fakePage(): Page {
  return {} as Page;
}

function fakeBrowser(pages: Page[]): FakeBrowser {
  const browser = {
    pagesCalls: 0,
    disconnectCalls: 0,
    closeCalls: 0,
    pages: async () => {
      browser.pagesCalls += 1;
      return pages;
    },
    disconnect: async () => {
      browser.disconnectCalls += 1;
    },
    close: async () => {
      browser.closeCalls += 1;
    },
  } as FakeBrowser;
  return browser;
}

function fakeDeps(): { deps: PageDeps; browser: FakeBrowser; connectTabCalls: () => number } {
  let connectTabCalls = 0;
  const browser = fakeBrowser([fakePage()]);
  const deps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      connectTabCalls += 1;
      return {} as never;
    },
  };
  return { deps, browser, connectTabCalls: () => connectTabCalls };
}

describe("BrowserPage", () => {
  test("attach returns the stored policy error for a blocked page without connecting", async () => {
    const { deps, connectTabCalls } = fakeDeps();
    const page = new BrowserPage(1, "chrome://newtab", deps);

    const result = await page.attach();

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(connectTabCalls()).toBe(0);
    expect(page.attached).toBe(false);
  });

  test("attach connects one allowed tab through ExtensionTransport-style deps", async () => {
    const { deps, browser, connectTabCalls } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);

    const result = await page.attach();

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(connectTabCalls()).toBe(1);
    expect(browser.pagesCalls).toBe(1);
    expect(page.attached).toBe(true);
    expect(page.page).not.toBeNull();
  });

  test("attach passes the cdp transport options without a default viewport", async () => {
    const { deps, browser } = fakeDeps();
    let received: unknown;
    const page = new BrowserPage(7, "https://example.com", {
      ...deps,
      connect: async (options) => {
        received = options;
        return browser;
      },
    });

    await page.attach();

    expect(received).toEqual({
      transport: expect.any(Object),
      protocol: "cdp",
      defaultViewport: null,
    });
  });

  test("attach fails and disconnects when the connection exposes no page", async () => {
    const { deps } = fakeDeps();
    const emptyBrowser = fakeBrowser([]);
    const page = new BrowserPage(7, "https://example.com", {
      ...deps,
      connect: async () => emptyBrowser,
    });

    const result = await page.attach();

    expect(result).toEqual({
      ok: false,
      error: { code: "attach_failed", message: "Connection exposed no page" },
    });
    expect(emptyBrowser.disconnectCalls).toBe(1);
    expect(page.attached).toBe(false);
  });

  test("attach returns attach_failed when the transport throws", async () => {
    const { deps } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", {
      ...deps,
      connectTab: async () => {
        throw new Error("tab not debuggable");
      },
    });

    const result = await page.attach();

    expect(result).toEqual({
      ok: false,
      error: { code: "attach_failed", message: "Failed to attach to tab" },
    });
    expect(page.attached).toBe(false);
  });

  test("attach returns attach_failed and leaves no connection when connect throws", async () => {
    const { deps } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", {
      ...deps,
      connect: async () => {
        throw new Error("connection refused");
      },
    });

    const result = await page.attach();

    expect(result).toEqual({
      ok: false,
      error: { code: "attach_failed", message: "Failed to attach to tab" },
    });
    expect(page.attached).toBe(false);
  });

  test("attach is idempotent for the same tab", async () => {
    const { deps, connectTabCalls } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);

    const first = await page.attach();
    const second = await page.attach();

    expect(first).toEqual({ ok: true, tabId: 7 });
    expect(second).toEqual({ ok: true, tabId: 7 });
    expect(connectTabCalls()).toBe(1);
  });

  test("disconnect calls Browser.disconnect and never Browser.close", async () => {
    const { deps, browser } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);
    await page.attach();

    await page.disconnect();
    await page.disconnect();

    expect(browser.disconnectCalls).toBe(1);
    expect(browser.closeCalls).toBe(0);
    expect(page.attached).toBe(false);
    expect(page.page).toBeNull();
  });

  test("disconnect without an attach is a no-op", async () => {
    const { deps, browser } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);

    await page.disconnect();

    expect(browser.disconnectCalls).toBe(0);
    expect(page.attached).toBe(false);
  });
});