import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { SerializableAXNode } from "../src/browser/observation/accessibility";
import {
  BUILD_HIGHLIGHT_OVERLAY_SOURCE,
  OBSERVE_PAGE_SOURCE,
  REMOVE_HIGHLIGHT_OVERLAY_SOURCE,
  renderPageContent,
} from "../src/browser/observation";
import type { ExtractedPageContent } from "../src/browser/observation";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { PageObservation } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+hKKKK/qw/yTP//Z";

const FIXTURE = `<!doctype html>
<html>
  <head><title>Capture fixture</title></head>
  <body>
    <label id="name-label" for="name">Name</label>
    <input id="name" type="text" name="name" value="Alice" />
    <button id="save" type="submit">Save</button>
    <a id="link" href="https://example.com">Read more</a>
    <div id="widget" role="button" tabindex="0">Widget</div>
  </body>
</html>`;

const LAYOUT = {
  name: { x: 60, y: 8, width: 160, height: 24 },
  save: { x: 8, y: 48, width: 90, height: 28 },
  link: { x: 8, y: 96, width: 90, height: 16 },
  widget: { x: 8, y: 128, width: 80, height: 20 },
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
  titleCalls: number;
  evaluateCalls: string[];
  evaluateError: Error | null;
  screenshotCalls: number;
  screenshotError: Error | null;
  screenshotGate: Promise<void> | null;
  lastScreenshotArgs: unknown;
  axSnapshots: Array<SerializableAXNode | null>;
}

interface FakeBrowser extends Browser {
  connected: boolean;
}

function fakePage(win: Window, currentUrl = "https://fixture.test/"): FakePage {
  const page = {
    currentUrl,
    titleCalls: 0,
    evaluateCalls: [] as string[],
    evaluateError: null,
    screenshotCalls: 0,
    screenshotError: null,
    screenshotGate: null,
    lastScreenshotArgs: null,
    axSnapshots: [],
    url: () => page.currentUrl,
    evaluate: async (expression: string): Promise<unknown> => {
      page.evaluateCalls.push(expression);
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
    title: async () => {
      page.titleCalls += 1;
      return "Capture fixture";
    },
    accessibility: {
      snapshot: async () => page.axSnapshots.shift() ?? null,
    },
    screenshot: async (options?: unknown) => {
      page.screenshotCalls += 1;
      page.lastScreenshotArgs = options;
      await page.screenshotGate;
      if (page.screenshotError) {
        throw page.screenshotError;
      }
      return JPEG_BASE64;
    },
  } as FakePage;
  return page;
}

function fakeBrowser(pages: Page[], options: { connected?: boolean } = {}): FakeBrowser {
  const browser = {
    connected: options.connected ?? true,
    pages: async () => pages,
    disconnect: async () => {},
    close: async () => {},
  } as FakeBrowser;
  return browser;
}

function fakeDeps(win: Window, currentUrl = "https://fixture.test/"): { deps: PageDeps; page: FakePage } {
  const page = fakePage(win, currentUrl);
  const browser = fakeBrowser([page]);
  const deps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      return {} as never;
    },
    timeoutMs: 100,
  };
  return { deps, page };
}

function evaluateSource(source: string): (...args: unknown[]) => unknown {
  return new Function(`return (${source});`)() as (...args: unknown[]) => unknown;
}

function overlayNodes(doc: Document): Element[] {
  return [...doc.querySelectorAll(".astra-obs-overlay, .astra-obs-target, .astra-obs-badge")];
}

describe("page observation scripts", () => {
  test("the composed page sources extract, highlight, and clean up in a real document", () => {
    const win = fixtureWindow();

    const extractFn = evaluateSource(OBSERVE_PAGE_SOURCE) as (win: Window) => ExtractedPageContent;
    const content = extractFn(win);
    const rendered = renderPageContent(content);
    expect(rendered.refs.map((r) => r.ref)).toEqual([1, 2, 3, 4]);

    const buildFn = evaluateSource(BUILD_HIGHLIGHT_OVERLAY_SOURCE) as (
      doc: Document,
      refs: typeof rendered.refs,
      viewport: typeof content.viewport,
    ) => void;
    buildFn(win.document, rendered.refs, content.viewport);
    expect(win.document.querySelectorAll(".astra-obs-badge")).toHaveLength(4);
    expect(win.document.querySelector("[data-astra-observation] style")).not.toBeNull();

    const removeFn = evaluateSource(REMOVE_HIGHLIGHT_OVERLAY_SOURCE) as (doc: Document) => void;
    removeFn(win.document);
    expect(overlayNodes(win.document)).toHaveLength(0);
    expect(win.document.querySelector("[data-astra-observation] style")).toBeNull();
  });
});

describe("BrowserPage.observe", () => {
  test("returns every page observation field from one ordered call", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    const state = (result as { ok: true; state: PageObservation }).state;
    expect(state.tabId).toBe(7);
    expect(state.url).toBe("https://fixture.test/");
    expect(state.title).toBe("Capture fixture");
    expect(state.scroll).toEqual(expect.objectContaining({ x: 0, y: 0 }));
    expect(state.dom).toContain("[1]<input role=textbox");
    expect(state.dom).toContain("[4]<div role=button");
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2, 3, 4]);
    expect(state.screenshot).toEqual({
      mimeType: "image/jpeg",
      data: JPEG_BASE64,
      width: 4,
      height: 4,
    });
    expect(page.screenshotCalls).toBe(1);
    expect(page.lastScreenshotArgs).toEqual({
      type: "jpeg",
      quality: 85,
      encoding: "base64",
    });

    expect(page.evaluateCalls).toHaveLength(3);
    expect(page.evaluateCalls[0]).toContain("extractPageContent(win)");
    expect(page.evaluateCalls[1]).toContain("buildHighlightOverlay(doc, refs, viewport, captureId)");
    expect(page.evaluateCalls[2]).toContain(
      "removeHighlightOverlay(doc, captureId)",
    );
    expect(overlayNodes(win.document)).toHaveLength(0);
  });

  test("applies Chromium accessibility roles and names to the ref records", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    page.axSnapshots = [
      { role: "textbox", name: "Full name" },
      { role: "button", name: "Save" },
      { role: "link", name: "Read more" },
      { role: "slider", name: "Volume" },
    ];
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    const state = (result as { ok: true; state: PageObservation }).state;
    expect(state.refs[0].name).toBe("Full name");
    expect(state.refs[3].role).toBe("slider");
    expect(state.refs[3].name).toBe("Volume");
  });

  test("returns selected_tab_unavailable when the page is not attached", async () => {
    const win = fixtureWindow();
    const { deps } = fakeDeps(win);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("rejects an unsupported current URL without reading page data", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win, "chrome://newtab");
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(page.evaluateCalls).toHaveLength(0);
    expect(page.titleCalls).toBe(0);
  });

  test("returns observation_failed without state when extraction fails", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    page.evaluateError = new Error("evaluation failed");
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
  });

  test("removes the highlight overlay when the screenshot fails", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    page.screenshotError = new Error("capture failed");
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(page.evaluateCalls[1]).toContain("buildHighlightOverlay(doc, refs, viewport, captureId)");
    expect(page.evaluateCalls[2]).toContain(
      "removeHighlightOverlay(doc, captureId)",
    );
    expect(overlayNodes(win.document)).toHaveLength(0);
    expect(win.document.querySelector("[data-astra-observation] style")).toBeNull();
  });

  test("rejects an observation when the page navigates during capture", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    let releaseScreenshot: (() => void) | null = null;
    page.screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const observation = wrapper.observe();
    while (page.screenshotCalls === 0) {
      await Promise.resolve();
    }
    page.currentUrl = "https://fixture.test/next";
    releaseScreenshot?.();
    const result = await observation;

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(overlayNodes(win.document)).toHaveLength(0);
  });

  test("serializes overlapping observations on one page", async () => {
    const win = fixtureWindow();
    const { deps, page } = fakeDeps(win);
    let releaseScreenshot: (() => void) | null = null;
    page.screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const first = wrapper.observe();
    while (page.screenshotCalls === 0) {
      await Promise.resolve();
    }
    const second = wrapper.observe();
    await Promise.resolve();
    await Promise.resolve();

    expect(page.screenshotCalls).toBe(1);
    releaseScreenshot?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(page.screenshotCalls).toBe(2);
    expect(overlayNodes(win.document)).toHaveLength(0);
  });
});
