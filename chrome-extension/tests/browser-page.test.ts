import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import { SnapshotStore } from "../src/browser/snapshot";

// Fast settle windows keep navigation completions off the production clocks.
const TEST_SETTLE_TIMINGS = { domQuietMs: 1, networkQuietMs: 1, pollMs: 1 };

// Loose matchers for the measured quiet spans whose idleMs values vary.
function quietSignals() {
  return {
    network: expect.objectContaining({ status: "quiet" }),
    dom: expect.objectContaining({ status: "quiet" }),
  };
}

class SpyStore extends SnapshotStore {
  invalidatedTabs: number[] = [];

  invalidate(tabId: number): void {
    this.invalidatedTabs.push(tabId);
    super.invalidate(tabId);
  }
}

interface FakeBrowser extends Browser {
  pagesCalls: number;
  disconnectCalls: number;
  closeCalls: number;
  connected: boolean;
}

interface FakePage extends Page {
  gotoCalls: number;
  goBackCalls: number;
  reloadCalls: number;
  currentUrl: string;
  lastGotoArgs: [string, unknown] | null;
  gotoError: Error | null;
  goBackError: Error | null;
  reloadError: Error | null;
  session: FakeSession;
}

class FakeSession extends EventEmitter {
  detached = false;

  async send(method: string): Promise<unknown> {
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-1", loaderId: "L1", url: "https://example.com" } } };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function fakePage(currentUrl = "https://example.com"): FakePage {
  const session = new FakeSession();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const page = {
    gotoCalls: 0,
    goBackCalls: 0,
    reloadCalls: 0,
    currentUrl,
    lastGotoArgs: null,
    gotoError: null,
    goBackError: null,
    reloadError: null,
    session,
    _client: () => session,
    createCDPSession: async () => session,
    frames: () => [],
    on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    goto: async (url: string, options?: unknown) => {
      page.gotoCalls += 1;
      page.lastGotoArgs = [url, options];
      if (page.gotoError) {
        throw page.gotoError;
      }
      // A successful goto commits a new main-frame document.
      session.emit("Page.frameNavigated", {
        frame: { id: "main-1", loaderId: `L${page.gotoCalls + 1}`, url },
        type: "Navigation",
      });
      return {};
    },
    goBack: async () => {
      page.goBackCalls += 1;
      if (page.goBackError) {
        throw page.goBackError;
      }
      // A successful back lands on a same-document history entry.
      session.emit("Page.navigatedWithinDocument", { frameId: "main-1", url: page.currentUrl });
      return {};
    },
    reload: async () => {
      page.reloadCalls += 1;
      if (page.reloadError) {
        throw page.reloadError;
      }
      // A successful reload commits a fresh document at the same URL.
      session.emit("Page.frameNavigated", {
        frame: { id: "main-1", loaderId: `L-r${page.reloadCalls}`, url: page.currentUrl },
        type: "Navigation",
      });
      return {};
    },
    url: () => page.currentUrl,
  } as FakePage;
  return page;
}

function fakeBrowser(pages: Page[], options: { connected?: boolean } = {}): FakeBrowser {
  const browser = {
    connected: options.connected ?? true,
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

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

function fakeDeps(
  overrides: Partial<PageDeps> = {},
  options: { connected?: boolean } = {},
): { deps: PageDeps; browser: FakeBrowser; page: FakePage; connectTabCalls: () => number } {
  let connectTabCalls = 0;
  const page = fakePage();
  const browser = fakeBrowser([page], options);
  const deps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      connectTabCalls += 1;
      return {} as never;
    },
    timeoutMs: 100,
    settleTimings: TEST_SETTLE_TIMINGS,
    ...overrides,
  };
  return { deps, browser, page, connectTabCalls: () => connectTabCalls };
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

  test("attach reuses the page session without requesting a forbidden nested CDP session", async () => {
    const { deps, page: connectedPage } = fakeDeps();
    connectedPage.createCDPSession = async () => {
      throw new Error("Not allowed");
    };
    const page = new BrowserPage(7, "https://example.com", deps);

    const result = await page.attach();

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(page.attached).toBe(true);
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
    const emptyBrowser = fakeBrowser([]);
    const { deps } = fakeDeps({ connect: async () => emptyBrowser });
    const page = new BrowserPage(7, "https://example.com", deps);

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

  test("attach returns attach_conflict when another debugger owns the tab", async () => {
    const { deps } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", {
      ...deps,
      connectTab: async () => {
        throw new Error("Another debugger is already attached to the tab with id: 7");
      },
    });

    const result = await page.attach();

    expect(result).toEqual({
      ok: false,
      error: { code: "attach_conflict", message: "Another debugger is attached to the tab" },
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

  test("disconnect leaves the borrowed page session for Browser.disconnect to close", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    expect(page.session.detached).toBe(false);

    await wrapper.disconnect();

    expect(page.session.detached).toBe(false);
  });

  test("disconnect without an attach is a no-op", async () => {
    const { deps, browser } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);

    const result = await page.disconnect();

    expect(result).toEqual({ ok: true });
    expect(browser.disconnectCalls).toBe(0);
    expect(page.attached).toBe(false);
  });

  test("disconnect reports a failure and still clears the wrapper when Browser.disconnect throws", async () => {
    const { deps, browser } = fakeDeps();
    const page = new BrowserPage(7, "https://example.com", deps);
    await page.attach();
    browser.disconnect = async () => {
      browser.disconnectCalls += 1;
      throw new Error("connection lost");
    };

    const result = await page.disconnect();
    const second = await page.disconnect();

    expect(result).toEqual({
      ok: false,
      error: { code: "disconnect_failed", message: "Failed to disconnect from tab" },
    });
    expect(second).toEqual({ ok: true });
    expect(browser.disconnectCalls).toBe(1);
    expect(page.attached).toBe(false);
    expect(page.page).toBeNull();
  });

  test("navigate goes to an allowed destination and reports its commit evidence", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "https://example.com/page2";

    const result = await wrapper.navigate("https://example.com/page2");

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/page2",
      commitType: "commit",
      documentEpoch: 1,
      navigationEpoch: 1,
      commits: [
        {
          kind: "main_commit",
          frameId: "main-1",
          parentFrameId: null,
          oldUrl: "https://example.com",
          newUrl: "https://example.com/page2",
          loaderId: "L2",
          documentEpoch: 1,
          navigationEpoch: 1,
        },
      ],
      signals: quietSignals(),
    });
    expect(page.gotoCalls).toBe(1);
    expect(page.lastGotoArgs).toEqual(["https://example.com/page2", { timeout: 100, waitUntil: "load" }]);
  });

  test("navigate rejects a blocked destination without calling goto", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    const result = await wrapper.navigate("chrome://newtab");

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(page.gotoCalls).toBe(0);
  });

  test("navigate returns selected_tab_unavailable when not attached", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);

    const result = await wrapper.navigate("https://example.com/page2");

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
    expect(page.gotoCalls).toBe(0);
  });

  test("navigate timeout keeps a connected wrapper reusable", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.gotoError = timeoutError("Navigation timeout of 100 ms exceeded");

    const result = await wrapper.navigate("https://example.com/slow");

    expect(result).toEqual({ ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } });
    expect(wrapper.attached).toBe(true);
  });

  test("navigate timeout detaches a dead connection so a later attach can recover", async () => {
    const { deps, page } = fakeDeps({}, { connected: false });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.gotoError = timeoutError("Navigation timeout of 100 ms exceeded");

    const result = await wrapper.navigate("https://example.com/slow");

    expect(result).toEqual({ ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } });
    expect(wrapper.attached).toBe(false);
    expect(wrapper.page).toBeNull();
  });

  test("navigate returns navigation_failed for other errors and keeps a live connection", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.gotoError = new Error("net::ERR_NAME_NOT_RESOLVED");

    const result = await wrapper.navigate("https://example.com/missing");

    expect(result).toEqual({ ok: false, error: { code: "navigation_failed", message: "Navigation failed" } });
    expect(wrapper.attached).toBe(true);
  });

  test("navigate rejects a redirect to an unsupported page", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "chrome://newtab";

    const result = await wrapper.navigate("https://example.com/redirect");

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_redirect", message: "Navigation ended on an unsupported page", url: "chrome://newtab" },
    });
    // Upfront dispatch, the observed commit through the tracker, and the
    // redirect failure each left the tab stale.
    expect(store.invalidatedTabs).toEqual([7, 7, 7]);
  });

  test("goBack navigates to the previous history entry", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "https://example.com/start";

    const result = await wrapper.goBack();

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/start",
      commitType: "same_document",
      documentEpoch: 0,
      navigationEpoch: 1,
      commits: [
        {
          kind: "same_document",
          frameId: "main-1",
          parentFrameId: null,
          oldUrl: "https://example.com",
          newUrl: "https://example.com/start",
          loaderId: "L1",
          documentEpoch: 0,
          navigationEpoch: 1,
        },
      ],
      signals: quietSignals(),
    });
    expect(page.goBackCalls).toBe(1);
  });

  test("goBack timeout returns navigation_timeout", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.goBackError = timeoutError("Navigation timeout of 100 ms exceeded");

    const result = await wrapper.goBack();

    expect(result).toEqual({ ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } });
  });

  test("reload reloads the current URL and re-checks it", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    const result = await wrapper.reload();

    expect(result).toEqual({
      ok: true,
      url: "https://example.com",
      commitType: "commit",
      documentEpoch: 1,
      navigationEpoch: 1,
      commits: [
        {
          kind: "main_commit",
          frameId: "main-1",
          parentFrameId: null,
          oldUrl: "https://example.com",
          newUrl: "https://example.com",
          loaderId: "L-r1",
          documentEpoch: 1,
          navigationEpoch: 1,
        },
      ],
      signals: quietSignals(),
    });
    expect(page.reloadCalls).toBe(1);
  });

  test("reload timeout returns navigation_timeout", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.reloadError = timeoutError("Navigation timeout of 100 ms exceeded");

    const result = await wrapper.reload();

    expect(result).toEqual({ ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } });
  });

  test("reload rejects a redirect to an unsupported page", async () => {
    const { deps, page } = fakeDeps();
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "https://chromewebstore.google.com/detail/xyz";
    const result = await wrapper.reload();

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_redirect",
        message: "Navigation ended on an unsupported page",
        url: "https://chromewebstore.google.com/detail/xyz",
      },
    });
  });

  test("navigate invalidates the snapshot cache before dispatch", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "https://example.com/page2";

    const result = await wrapper.navigate("https://example.com/page2");

    expect(result.ok).toBe(true);
    // Once up front, then again when the tracker sees the committed document.
    expect(store.invalidatedTabs).toEqual([7, 7]);
    expect(page.gotoCalls).toBe(1);
  });

  test("navigate invalidates the snapshot cache even when dispatch fails", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.gotoError = timeoutError("Navigation timeout of 100 ms exceeded");

    const result = await wrapper.navigate("https://example.com/slow");

    expect(result.ok).toBe(false);
    expect(store.invalidatedTabs).toEqual([7]);
  });

  test("navigate to a blocked destination does not invalidate the snapshot cache", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    const result = await wrapper.navigate("chrome://newtab");

    expect(result.ok).toBe(false);
    expect(store.invalidatedTabs).toEqual([]);
    expect(page.gotoCalls).toBe(0);
  });

  test("goBack invalidates the snapshot cache before dispatch", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();
    page.currentUrl = "https://example.com/start";

    const result = await wrapper.goBack();

    expect(result.ok).toBe(true);
    // Once up front, then again when the tracker sees the route change.
    expect(store.invalidatedTabs).toEqual([7, 7]);
    expect(page.goBackCalls).toBe(1);
  });

  test("reload invalidates the snapshot cache before dispatch", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    const result = await wrapper.reload();

    expect(result.ok).toBe(true);
    // Once up front, then again when the tracker sees the fresh document.
    expect(store.invalidatedTabs).toEqual([7, 7]);
    expect(page.reloadCalls).toBe(1);
  });

  test("an external full-document navigation invalidates the snapshot cache", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    page.session.emit("Page.frameNavigated", {
      frame: { id: "main-1", loaderId: "L2", url: "https://example.com/page2" },
      type: "Navigation",
    });

    expect(store.invalidatedTabs).toEqual([7]);
  });

  test("a same-document navigation invalidates the snapshot cache", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    page.session.emit("Page.navigatedWithinDocument", {
      frameId: "main-1",
      url: "https://example.com/#section",
    });

    expect(store.invalidatedTabs).toEqual([7]);
  });

  test("a subframe navigation does not invalidate the snapshot cache", async () => {
    const store = new SpyStore();
    const { deps, page } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    page.session.emit("Page.frameNavigated", {
      frame: { id: "sub-1", parentId: "main-1", loaderId: "L2", url: "https://example.com/widget" },
      type: "Navigation",
    });

    expect(store.invalidatedTabs).toEqual([]);
  });

  test("disconnect invalidates the snapshot cache", async () => {
    const store = new SpyStore();
    const { deps } = fakeDeps({ snapshotStore: store });
    const wrapper = new BrowserPage(7, "https://example.com", deps);
    await wrapper.attach();

    await wrapper.disconnect();

    expect(store.invalidatedTabs).toEqual([7]);
  });
});
