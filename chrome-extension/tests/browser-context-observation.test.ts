import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { BrowserContext } from "../src/browser/context";
import type { PageDeps } from "../src/browser/page";
import type { BrowserState } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg6OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm6Onq8vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+hKKKK/qw/yTP//Z";

const FIXTURE = `<!doctype html>
<html>
  <head><title>Context fixture</title></head>
  <body>
    <h1>Heading</h1>
    <p>Some visible text.</p>
    <label for="name">Name</label>
    <input id="name" type="text" value="Alice" />
    <button id="save" type="submit">Save</button>
    <a id="link" href="https://example.com">Read more</a>
  </body>
</html>`;

const LAYOUT = {
  name: { x: 60, y: 8, width: 160, height: 24 },
  save: { x: 8, y: 48, width: 90, height: 28 },
  link: { x: 8, y: 96, width: 90, height: 16 },
};

function fixtureWindow(): Window {
  const win = new Window({
    url: "https://fixture.test/",
    innerWidth: VIEWPORT_WIDTH,
    innerHeight: VIEWPORT_HEIGHT,
  });
  win.document.write(FIXTURE);
  win.document.close();
  for (const [id, bounds] of Object.entries(LAYOUT)) {
    const el = win.document.getElementById(id);
    if (!el) {
      throw new Error(`Fixture element #${id} not found`);
    }
    Object.defineProperty(el, "getBoundingClientRect", { value: () => bounds });
  }
  return win;
}

interface FakePage extends Page {
  currentUrl: string;
  evaluateError: Error | null;
  screenshotError: Error | null;
}

interface FakeBrowser extends Browser {
  connected: boolean;
}

function fakePage(win: Window, currentUrl = "https://fixture.test/"): FakePage {
  const page = {
    currentUrl,
    evaluateError: null,
    screenshotError: null,
    url: () => page.currentUrl,
    evaluate: async (expression: string): Promise<unknown> => {
      if (page.evaluateError) {
        throw page.evaluateError;
      }
      const runner = new Function("window", "document", `return (${expression});`);
      return runner(win, win.document);
    },
    evaluateHandle: async (_fn: unknown, domPath: number[]) => {
      let node: Node | null = win.document.body;
      for (const index of domPath) {
        node = node?.childNodes.item(index) ?? null;
      }
      const resolved = node instanceof win.Element ? node : null;
      return {
        asElement: () =>
          resolved
            ? {
                evaluate: async () => resolved.tagName.toLowerCase(),
              }
            : null,
        dispose: async () => {},
      };
    },
    title: async () => "Context fixture",
    accessibility: {
      snapshot: async () => null,
    },
    screenshot: async () => {
      if (page.screenshotError) {
        throw page.screenshotError;
      }
      return JPEG_BASE64;
    },
  } as FakePage;
  return page;
}

function fakeBrowser(page: FakePage): FakeBrowser {
  const browser = {
    connected: true,
    pages: async () => [page],
    disconnect: async () => {},
    close: async () => {},
  } as FakeBrowser;
  return browser;
}

interface FakeDeps {
  context: BrowserContext;
  page: FakePage;
  win: Window;
}

function setup(options: {
  tabs?: chrome.tabs.Tab[];
  allTabs?: chrome.tabs.Tab[];
  page?: (win: Window) => FakePage;
  queryTabsError?: Error;
} = {}): FakeDeps {
  const win = fixtureWindow();
  const page = options.page ? options.page(win) : fakePage(win);
  const browser = fakeBrowser(page);
  const pageDeps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      return {} as never;
    },
    timeoutMs: 100,
  };

  const context = new BrowserContext({
    queryActiveTab: async () => options.tabs ?? [],
    queryTabs: async () => {
      if (options.queryTabsError) {
        throw options.queryTabsError;
      }
      return options.allTabs ?? [];
    },
    onUpdated: () => () => {},
    onActivated: () => () => {},
    onRemoved: () => () => {},
    onDetach: () => () => {},
    diagnostics: () => {},
    pageDeps,
    timeoutMs: 100,
  });

  return { context, page, win };
}

function activeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab[] {
  return [{ id: 7, url: "https://fixture.test/", ...overrides } as chrome.tabs.Tab];
}

describe("BrowserContext.observe", () => {
  test("returns one serializable state with the selected tab and tab flags", async () => {
    const { context } = setup({
      tabs: activeTab(),
      allTabs: [
        { id: 7, url: "https://fixture.test/", title: "Context fixture" } as chrome.tabs.Tab,
        { id: 8, url: "https://other.test/", title: "Other" } as chrome.tabs.Tab,
        { id: 9, url: "chrome://newtab", title: "New Tab" } as chrome.tabs.Tab,
      ],
    });
    await context.useActiveTab();

    const result = await context.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const state = result.state;
    expect(state.tabId).toBe(7);
    expect(state.url).toBe("https://fixture.test/");
    expect(state.title).toBe("Context fixture");
    expect(state.tabs).toEqual([
      { tabId: 7, url: "https://fixture.test/", title: "Context fixture", attached: true, selected: true },
      { tabId: 8, url: "https://other.test/", title: "Other", attached: false, selected: false },
    ]);
    expect(state.dom).toContain("[1]<input role=textbox");
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2, 3]);
    expect(state.screenshot).toEqual({
      mimeType: "image/jpeg",
      data: JPEG_BASE64,
      width: 4,
      height: 4,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("returns selected_tab_unavailable when no live connection is selected", async () => {
    const { context } = setup({});

    const result = await context.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("returns observation_failed without partial state when page observation fails", async () => {
    const { context, page } = setup({
      tabs: activeTab(),
      page: (win) => {
        const page = fakePage(win);
        page.evaluateError = new Error("evaluation failed");
        return page;
      },
    });
    await context.useActiveTab();

    const result = await context.observe();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toEqual({
      code: "observation_failed",
      message: "Page observation failed",
    });
    expect("state" in result).toBe(false);
    expect(page.screenshotError).toBeNull();
  });

  test("normalizes a tab-listing failure without returning partial state", async () => {
    const { context } = setup({
      tabs: activeTab(),
      queryTabsError: new Error("boom"),
    });
    await context.useActiveTab();

    const result = await context.observe();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toEqual({
      code: "observation_failed",
      message: "Browser observation failed",
    });
    expect("state" in result).toBe(false);
  });

  test("observing twice returns fresh refs from the same connection", async () => {
    const { context } = setup({
      tabs: activeTab(),
      allTabs: [{ id: 7, url: "https://fixture.test/", title: "Context fixture" } as chrome.tabs.Tab],
    });
    await context.useActiveTab();
    await context.observe();

    const second = await context.observe();

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected success");
    const state = second.state as BrowserState;
    expect(state.tabId).toBe(7);
    expect(state.tabs[0]).toMatchObject({ tabId: 7, selected: true });
    expect(state.dom).toContain("[1]<input role=textbox");
  });
});
