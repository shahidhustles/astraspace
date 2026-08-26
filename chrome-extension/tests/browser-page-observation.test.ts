import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
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
import { SnapshotStore } from "../src/browser/snapshot";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { PageObservation, SnapshotId } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const MAIN_FRAME_ID = "main-1";
const CHILD_FRAME_ID = "child-1";
const GRANDCHILD_FRAME_ID = "grandchild-1";

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

class FakeElementHandle {
  constructor(
    readonly element: Element | null,
    readonly win: Window,
    readonly backendNodeIdValue: number,
  ) {}

  async evaluate<T>(fn: (node: Node) => T): Promise<T> {
    if (!this.element) {
      return null as T;
    }
    const source = fn.toString();
    const runner = new Function(
      "window",
      "document",
      "Element",
      "HTMLElement",
      "node",
      `return (${source})(node);`,
    );
    return runner(this.win, this.win.document, this.win.Element, this.win.HTMLElement, this.element) as T;
  }

  async backendNodeId(): Promise<number> {
    return this.backendNodeIdValue;
  }

  async dispose(): Promise<void> {}
}

class FakeFrame {
  constructor(
    readonly win: Window,
    readonly evaluateCalls: string[],
    readonly children: FakeFrame[] = [],
    readonly frameElementHandle: FakeElementHandle | null = null,
    readonly evaluateError: Error | null = null,
    readonly backendNodeIdFor: (el: Element) => number = () => 0,
    readonly removeOverlayError: Error | null = null,
  ) {}

  childFrames(): FakeFrame[] {
    return this.children;
  }

  async frameElement(): Promise<FakeElementHandle | null> {
    return this.frameElementHandle;
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls.push(expression);
    if (this.removeOverlayError && expression.includes("removeHighlightOverlay")) {
      throw this.removeOverlayError;
    }
    if (this.evaluateError) {
      throw this.evaluateError;
    }
    const runner = new Function("window", "document", `return (${expression});`);
    return runner(this.win, this.win.document);
  }

  async evaluateHandle(fn: (arg: unknown) => unknown, arg: unknown): Promise<FakeHandleResult> {
    const source = fn.toString();
    const runner = new Function(
      "window",
      "document",
      "Element",
      "ShadowRoot",
      "arg",
      `return (${source})(arg);`,
    );
    const resolved = runner(this.win, this.win.document, this.win.Element, this.win.ShadowRoot, arg) as
      | Node
      | null;
    return {
      asElement: () =>
        resolved && resolved.nodeType === 1
          ? new FakeElementHandle(resolved as Element, this.win, this.backendNodeIdFor(resolved as Element))
          : null,
      dispose: async () => {},
    };
  }
}

interface FakeHandleResult {
  asElement: () => FakeElementHandle | null;
  dispose: () => Promise<void>;
}

class FakeSession extends EventEmitter {
  detached = false;
  sent: string[] = [];
  frameTree: { frame: Record<string, unknown>; childFrames?: unknown[] } | null = null;
  ownerNodes = new Map<string, number>();

  async send(method: string, params?: { frameId?: string }): Promise<unknown> {
    this.sent.push(method);
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      if (!this.frameTree) {
        throw new Error("no frame tree configured");
      }
      return { frameTree: this.frameTree };
    }
    if (method === "DOM.getFrameOwner") {
      const frameId = params?.frameId;
      if (!frameId) {
        throw new Error("missing frameId");
      }
      const backendNodeId = this.ownerNodes.get(frameId);
      if (backendNodeId === undefined) {
        throw new Error(`no owner node for ${frameId}`);
      }
      return { backendNodeId, nodeId: backendNodeId };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function mainFrameTree(children?: unknown[]): { frame: Record<string, unknown>; childFrames?: unknown[] } {
  const tree = {
    frame: { id: MAIN_FRAME_ID, loaderId: "L1", url: "https://fixture.test/" },
  };
  if (children && children.length > 0) {
    return { ...tree, childFrames: children };
  }
  return tree;
}

function fakePage(
  win: Window,
  currentUrl = "https://fixture.test/",
  session = new FakeSession(),
  children: FakeFrame[] = [],
  options: { evaluateError?: Error | null } = {},
): { page: FakePage; mainFrame: FakeFrame } {
  const evaluateCalls: string[] = [];
  const mainFrame = new FakeFrame(win, evaluateCalls, children, null, options.evaluateError ?? null);
  const page = {
    currentUrl,
    titleCalls: 0,
    evaluateCalls,
    evaluateError: options.evaluateError ?? null,
    screenshotCalls: 0,
    screenshotError: null,
    screenshotGate: null,
    lastScreenshotArgs: null,
    axSnapshots: [],
    url: () => page.currentUrl,
    createCDPSession: async () => session,
    mainFrame: () => mainFrame,
    evaluate: async (expression: string): Promise<unknown> => mainFrame.evaluate(expression),
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
  return { page, mainFrame };
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

function fakeDeps(
  win: Window,
  currentUrl = "https://fixture.test/",
  snapshotStore?: SnapshotStore,
  options: { evaluateError?: Error | null } = {},
): { deps: PageDeps; page: FakePage; session: FakeSession; mainFrame: FakeFrame } {
  const session = new FakeSession();
  session.frameTree = mainFrameTree();
  const { page, mainFrame } = fakePage(win, currentUrl, session, [], options);
  const browser = fakeBrowser([page]);
  const deps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => {
      return {} as never;
    },
    timeoutMs: 100,
    ...(snapshotStore ? { snapshotStore } : {}),
  };
  return { deps, page, session, mainFrame };
}

function sequencedUuids(): () => string {
  let next = 0;
  return () => `snap-${(next += 1)}`;
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

    const extractFn = evaluateSource(OBSERVE_PAGE_SOURCE) as (
      win: Window,
      startRef: number,
      owners: Record<string, string>,
    ) => { content: ExtractedPageContent; nextRef: number };
    const { content } = extractFn(win, 1, {});
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
    const { deps, page } = fakeDeps(win, "https://fixture.test/", new SnapshotStore({ createUuid: sequencedUuids() }));
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
    expect(state.snapshotId).toBe("snap-1");
    expect(state.snapshotVersion).toBe(1);
    expect(state.documentEpoch).toBe(0);
    expect(state.navigationEpoch).toBe(0);
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
    expect(page.evaluateCalls[0]).toContain("extractFrameContent(win, startRef, owners)");
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
    const { deps, page } = fakeDeps(win, "https://fixture.test/", undefined, {
      evaluateError: new Error("evaluation failed"),
    });
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

  test("two successful observations return unique IDs and increasing versions with current epochs", async () => {
    const win = fixtureWindow();
    const { deps } = fakeDeps(win, "https://fixture.test/", new SnapshotStore({ createUuid: sequencedUuids() }));
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const first = await wrapper.observe();
    const second = await wrapper.observe();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected success");
    expect(first.state.snapshotId).toBe("snap-1");
    expect(first.state.snapshotVersion).toBe(1);
    expect(first.state.documentEpoch).toBe(0);
    expect(first.state.navigationEpoch).toBe(0);
    expect(second.state.snapshotId).toBe("snap-2");
    expect(second.state.snapshotVersion).toBe(2);
    expect(second.state.documentEpoch).toBe(0);
    expect(second.state.navigationEpoch).toBe(0);
    expect(first.state.snapshotId).not.toBe(second.state.snapshotId);
    expect(first.state.dom).toBe(second.state.dom);
  });

  test("a failed capture consumes no version and disables earlier snapshots until a later success", async () => {
    const win = fixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, page } = fakeDeps(win, "https://fixture.test/", store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const first = await wrapper.observe();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected success");

    page.screenshotError = new Error("capture failed");
    const failed = await wrapper.observe();
    expect(failed).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(
      store.lookup({ tabId: 7, snapshotId: first.state.snapshotId, ref: 1 }, { documentEpoch: 0, navigationEpoch: 0 }),
    ).toEqual({ ok: false, code: "stale_ref", target: expect.any(Object), reason: expect.any(String) });

    page.screenshotError = null;
    const third = await wrapper.observe();
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("expected success");
    expect(third.state.snapshotVersion).toBe(2);
  });

  test("rejects an observation when the frame identity changes during capture", async () => {
    const win = fixtureWindow();
    const { deps, page, session } = fakeDeps(
      win,
      "https://fixture.test/",
      new SnapshotStore({ createUuid: sequencedUuids() }),
    );
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
    session.emit("Page.frameNavigated", {
      frame: { id: MAIN_FRAME_ID, loaderId: "L2", url: "https://fixture.test/next" },
      type: "Navigation",
    });
    releaseScreenshot?.();
    const result = await observation;

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(overlayNodes(win.document)).toHaveLength(0);
  });

  test("rejects a staged commit when the frame identity changes before commit", async () => {
    const win = fixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, session } = fakeDeps(win, "https://fixture.test/", store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const staged = await wrapper.stageObservation();
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("expected success");

    session.emit("Page.frameNavigated", {
      frame: { id: MAIN_FRAME_ID, loaderId: "L2", url: "https://fixture.test/next" },
      type: "Navigation",
    });

    const committed = wrapper.commitObservation(staged.staged);

    expect(committed).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(
      store.lookup({ tabId: 7, snapshotId: "snap-1" as SnapshotId, ref: 1 }, { documentEpoch: 0, navigationEpoch: 0 }),
    ).toEqual({ ok: false, code: "stale_ref", target: expect.any(Object), reason: expect.any(String) });

    const retry = await wrapper.observe();
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("expected success");
    expect(retry.state.snapshotVersion).toBe(1);
  });

  test("rejects a staged commit after the page disconnects", async () => {
    const win = fixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps } = fakeDeps(win, "https://fixture.test/", store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const staged = await wrapper.stageObservation();
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("expected success");
    await wrapper.disconnect();

    expect(wrapper.commitObservation(staged.staged)).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(
      store.lookup({ tabId: 7, snapshotId: "snap-1" as SnapshotId, ref: 1 }, { documentEpoch: 0, navigationEpoch: 0 }),
    ).toEqual({ ok: false, code: "stale_ref", target: expect.any(Object), reason: expect.any(String) });
  });

  test("an unsupported current URL invalidates the previous snapshot", async () => {
    const win = fixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, page } = fakeDeps(win, "https://fixture.test/", store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const first = await wrapper.observe();
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected success");

    page.currentUrl = "chrome://newtab";
    const failed = await wrapper.observe();

    expect(failed).toEqual({
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: "chrome://newtab" },
    });
    expect(
      store.lookup(
        { tabId: 7, snapshotId: first.state.snapshotId, ref: 1 },
        { documentEpoch: first.state.documentEpoch, navigationEpoch: first.state.navigationEpoch },
      ),
    ).toEqual({ ok: false, code: "stale_ref", target: expect.any(Object), reason: expect.any(String) });
  });

  test("publishes frame and main content in one tree with unique refs", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `
      <button id="main-btn">Main action</button>
      <iframe id="frame"></iframe>
    `;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({
      url: "https://child.test/",
      innerWidth: 400,
      innerHeight: 300,
    });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101), null, () => 201);
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [{ role: "button", name: "Main action" }, { role: "button", name: "Child action" }];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const state = result.state;
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2]);
    expect(state.dom).toContain("[1]<button>Main action />");
    expect(state.dom).toContain("<frame>");
    expect(state.dom).toContain("[2]<button>Child action />");
    expect(state.dom.indexOf("<frame>")).toBeLessThan(state.dom.indexOf("[2]<button"));
    expect(page.evaluateCalls[0]).toContain('"child-1"');
    expect(overlayNodes(parentWin.document)).toHaveLength(0);
  });

  test("groundings carry frame lineage, backend node IDs, and locator segments across frames", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101), null, () => 201);
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
      snapshotStore: store,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");

    const lookup = store.lookup(
      { tabId: 7, snapshotId: observed.state.snapshotId, ref: 2 },
      { documentEpoch: 0, navigationEpoch: 0 },
    );
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error("expected grounding");
    expect(lookup.grounding.frameLineage).toEqual([
      { frameId: MAIN_FRAME_ID, parentFrameId: null, documentEpoch: 0, navigationEpoch: 0 },
      { frameId: CHILD_FRAME_ID, parentFrameId: MAIN_FRAME_ID, documentEpoch: 0, navigationEpoch: 0 },
    ]);
    expect(lookup.grounding.backendNodeId).toBe(201);
    expect(lookup.grounding.cssSegments).toEqual(["button:nth-child(1)"]);
    expect(lookup.grounding.text).toBe("Child action");
    expect(JSON.parse(JSON.stringify(lookup.grounding))).toEqual(lookup.grounding);
  });

  test("a failing frame extraction fails the complete observation", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101), new Error("frame evaluation failed"));
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
  });

  test("an iframe missing from the owners map fails the observation", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const drifted = parentWin.document.createElement("div");
    drifted.textContent = "Not the frame";
    const childFrame = new FakeFrame(
      childWin,
      [],
      [],
      new FakeElementHandle(drifted, parentWin, 101),
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
  });

  test("a child-frame graph change during extraction fails the observation", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);

    const originalEvaluate = FakeFrame.prototype.evaluate;
    FakeFrame.prototype.evaluate = async function (
      this: FakeFrame,
      expression: string,
    ): Promise<unknown> {
      if (this.children.length === 0 && this.frameElementHandle !== null) {
        session.emit("Page.frameDetached", { frameId: CHILD_FRAME_ID });
      }
      return originalEvaluate.call(this, expression);
    };
    try {
      const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101));
      const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
      const deps: PageDeps = {
        connect: async () => fakeBrowser([page]),
        connectTab: async () => ({}) as never,
        timeoutMs: 100,
      };
      const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
      await wrapper.attach();

      const result = await wrapper.observe();

      expect(result).toEqual({
        ok: false,
        error: { code: "observation_failed", message: "Page observation failed" },
      });
    } finally {
      FakeFrame.prototype.evaluate = originalEvaluate;
    }
  });

  test("publishes nested frame controls in one ordered tree with unique refs", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `
      <button id="main-btn">Main action</button>
      <iframe id="frame"></iframe>
    `;
    const mainButton = parentWin.document.getElementById("main-btn");
    const parentIframe = parentWin.document.getElementById("frame");
    if (!mainButton || !parentIframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({
      url: "https://child.test/",
      innerWidth: 400,
      innerHeight: 300,
    });
    childWin.document.body.innerHTML = `
      <button id="child-btn">Child action</button>
      <iframe id="nested-frame"></iframe>
    `;
    const childButton = childWin.document.getElementById("child-btn");
    const childIframe = childWin.document.getElementById("nested-frame");
    if (!childButton || !childIframe) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const grandchildWin = new Window({
      url: "https://grandchild.test/",
      innerWidth: 300,
      innerHeight: 200,
    });
    grandchildWin.document.body.innerHTML = `<button id="grand-btn">Grandchild action</button>`;
    const grandchildButton = grandchildWin.document.getElementById("grand-btn");
    if (!grandchildButton) throw new Error("grandchild fixture missing");
    Object.defineProperty(grandchildButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      {
        frame: {
          id: CHILD_FRAME_ID,
          parentId: MAIN_FRAME_ID,
          loaderId: "L2",
          url: "https://child.test/",
        },
        childFrames: [
          {
            frame: {
              id: GRANDCHILD_FRAME_ID,
              parentId: CHILD_FRAME_ID,
              loaderId: "L3",
              url: "https://grandchild.test/",
            },
          },
        ],
      },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    session.ownerNodes.set(GRANDCHILD_FRAME_ID, 102);
    const childCalls: string[] = [];
    const grandchildFrame = new FakeFrame(
      grandchildWin,
      [],
      [],
      new FakeElementHandle(childIframe, childWin, 102),
      null,
      () => 302,
    );
    const childFrame = new FakeFrame(
      childWin,
      childCalls,
      [grandchildFrame],
      new FakeElementHandle(parentIframe, parentWin, 101),
      null,
      () => 301,
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [
      { role: "button", name: "Main action" },
      { role: "button", name: "Child action" },
      { role: "button", name: "Grandchild action" },
    ];
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
      snapshotStore: store,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const state = result.state;
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2, 3]);
    expect(state.dom).toContain("[1]<button>Main action />");
    expect(state.dom).toContain("<frame>");
    expect(state.dom).toContain("[2]<button>Child action />");
    expect(state.dom).toContain("[3]<button>Grandchild action />");
    expect(state.dom.indexOf("[1]<button")).toBeLessThan(state.dom.indexOf("<frame>"));
    expect(state.dom.indexOf("<frame>")).toBeLessThan(state.dom.indexOf("[2]<button"));
    expect(state.dom.indexOf("[2]<button")).toBeLessThan(state.dom.lastIndexOf("<frame>"));
    expect(state.dom.lastIndexOf("<frame>")).toBeLessThan(state.dom.indexOf("[3]<button"));
    expect(page.evaluateCalls[0]).toContain('"child-1"');
    expect(childCalls[0]).toContain('"grandchild-1"');

    const childLookup = store.lookup(
      { tabId: 7, snapshotId: state.snapshotId, ref: 2 },
      { documentEpoch: 0, navigationEpoch: 0 },
    );
    expect(childLookup.ok).toBe(true);
    if (!childLookup.ok) throw new Error("expected grounding");
    expect(childLookup.grounding.frameLineage).toEqual([
      { frameId: MAIN_FRAME_ID, parentFrameId: null, documentEpoch: 0, navigationEpoch: 0 },
      { frameId: CHILD_FRAME_ID, parentFrameId: MAIN_FRAME_ID, documentEpoch: 0, navigationEpoch: 0 },
    ]);
    expect(childLookup.grounding.backendNodeId).toBe(301);

    const grandchildLookup = store.lookup(
      { tabId: 7, snapshotId: state.snapshotId, ref: 3 },
      { documentEpoch: 0, navigationEpoch: 0 },
    );
    expect(grandchildLookup.ok).toBe(true);
    if (!grandchildLookup.ok) throw new Error("expected grounding");
    expect(grandchildLookup.grounding.frameLineage).toEqual([
      { frameId: MAIN_FRAME_ID, parentFrameId: null, documentEpoch: 0, navigationEpoch: 0 },
      { frameId: CHILD_FRAME_ID, parentFrameId: MAIN_FRAME_ID, documentEpoch: 0, navigationEpoch: 0 },
      { frameId: GRANDCHILD_FRAME_ID, parentFrameId: CHILD_FRAME_ID, documentEpoch: 0, navigationEpoch: 0 },
    ]);
    expect(grandchildLookup.grounding.backendNodeId).toBe(302);
    expect(JSON.parse(JSON.stringify(grandchildLookup.grounding))).toEqual(grandchildLookup.grounding);
  });

  test("enriches open-shadow controls inside child frames through shadow path steps", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<div id="host"><button id="shadow-btn">Shadow action</button></div>`;
    const host = childWin.document.getElementById("host");
    const shadowButton = childWin.document.getElementById("shadow-btn");
    if (!host || !shadowButton) throw new Error("child fixture missing");
    host.attachShadow({ mode: "open" });
    host.shadowRoot!.appendChild(shadowButton);
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 300, height: 60 }),
    });
    Object.defineProperty(shadowButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 16, width: 120, height: 20 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101), null, () => 201);
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [
      { role: "button", name: "Main action" },
      { role: "button", name: "Shadow action" },
    ];
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
      snapshotStore: store,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const state = result.state;
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2]);
    expect(state.dom).toContain("<frame>");
    expect(state.dom).toContain("<#shadow-root>");
    expect(state.dom).toContain("[2]<button>Shadow action />");

    const lookup = store.lookup(
      { tabId: 7, snapshotId: state.snapshotId, ref: 2 },
      { documentEpoch: 0, navigationEpoch: 0 },
    );
    expect(lookup.ok).toBe(true);
    if (!lookup.ok) throw new Error("expected grounding");
    expect(lookup.grounding.domPath).toContainEqual({ kind: "shadow" });
    expect(lookup.grounding.cssSegments).toEqual(["div:nth-child(1)", "button:nth-child(1)"]);
    expect(lookup.grounding.xpathSegments).toEqual(["/div[1]", "/button[1]"]);
    expect(lookup.grounding.text).toBe("Shadow action");
  });

  test("binds an iframe nested inside an open shadow root through shadow-aware owner paths", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `
      <button id="main-btn">Main action</button>
      <div id="host"><iframe id="frame"></iframe></div>
    `;
    const mainButton = parentWin.document.getElementById("main-btn");
    const host = parentWin.document.getElementById("host");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !host || !iframe) throw new Error("parent fixture missing");
    host.attachShadow({ mode: "open" });
    host.shadowRoot!.appendChild(iframe);
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });
    Object.defineProperty(host, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 48, width: 300, height: 200 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], [], new FakeElementHandle(iframe, parentWin, 101), null, () => 201);
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [
      { role: "button", name: "Main action" },
      { role: "button", name: "Child action" },
    ];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const state = result.state;
    expect(state.refs.map((r) => r.ref)).toEqual([1, 2]);
    expect(state.dom).toContain("<#shadow-root>");
    expect(state.dom).toContain("<frame>");
    expect(state.dom).toContain("[2]<button>Child action />");
  });

  test("nested-frame public bounds translate through the iframe owner into top-viewport coordinates", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `
      <button id="main-btn">Main action</button>
      <iframe id="frame"></iframe>
    `;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });
    Object.defineProperty(iframe, "getBoundingClientRect", {
      value: () => ({ x: 100, y: 50, width: 300, height: 200 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childCalls: string[] = [];
    const childFrame = new FakeFrame(
      childWin,
      childCalls,
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [{ role: "button", name: "Main action" }, { role: "button", name: "Child action" }];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.state.refs.map((r) => r.ref)).toEqual([1, 2]);
    expect(result.state.refs[0].bounds).toEqual({ x: 8, y: 8, width: 90, height: 28 });
    expect(result.state.refs[1].bounds).toEqual({ x: 108, y: 58, width: 90, height: 28 });

    const childBuild = childCalls.find((call) => call.includes("buildHighlightOverlay"));
    expect(childBuild).toBeDefined();
    expect(childBuild).toContain('"x":8');
    expect(childBuild).not.toContain('"x":108');
  });

  test("a fully clipped nested control publishes no visible ref", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `
      <button id="main-btn">Main action</button>
      <iframe id="frame"></iframe>
    `;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });
    Object.defineProperty(iframe, "getBoundingClientRect", {
      value: () => ({ x: 900, y: 50, width: 300, height: 200 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(
      childWin,
      [],
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [{ role: "button", name: "Main action" }, { role: "button", name: "Child action" }];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.state.refs.map((r) => r.ref)).toEqual([1, 2]);
    expect(result.state.refs[0].bounds).toEqual({ x: 8, y: 8, width: 90, height: 28 });
    expect(result.state.refs[1].bounds).toBeNull();
  });

  test("installs and removes the per-frame overlay inside the owning frame", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childCalls: string[] = [];
    const childFrame = new FakeFrame(
      childWin,
      childCalls,
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [{ role: "button", name: "Main action" }, { role: "button", name: "Child action" }];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result.ok).toBe(true);
    expect(childCalls.filter((call) => call.includes("((doc, refs, viewport, captureId) =>"))).toHaveLength(1);
    expect(childCalls.filter((call) => call.includes("((doc, captureId) =>"))).toHaveLength(1);
    expect(page.evaluateCalls.filter((call) => call.includes("((doc, refs, viewport, captureId) =>"))).toHaveLength(1);
    expect(page.evaluateCalls.filter((call) => call.includes("((doc, captureId) =>"))).toHaveLength(1);
    expect(childWin.document.querySelector("[data-astra-observation]")).toBeNull();
    expect(childWin.document.querySelectorAll(".astra-obs-overlay, .astra-obs-target, .astra-obs-badge")).toHaveLength(0);
    expect(overlayNodes(parentWin.document)).toHaveLength(0);
  });

  test("an overlay cleanup failure in a child frame fails the observation", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(
      childWin,
      [],
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
      new Error("child frame cleanup failed"),
    );
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.axSnapshots = [{ role: "button", name: "Main action" }, { role: "button", name: "Child action" }];
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const result = await wrapper.observe();

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(overlayNodes(parentWin.document)).toHaveLength(0);
  });

  test("a child-frame navigation during capture fails the observation", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(
      childWin,
      [],
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
    );
    let releaseScreenshot: (() => void) | null = null;
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    page.screenshotGate = new Promise<void>((resolve) => {
      releaseScreenshot = resolve;
    });
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const observation = wrapper.observe();
    while (page.screenshotCalls === 0) {
      await Promise.resolve();
    }
    session.emit("Page.frameNavigated", {
      frame: { id: CHILD_FRAME_ID, loaderId: "L2b", url: "https://child.test/next" },
      type: "Navigation",
    });
    releaseScreenshot?.();
    const result = await observation;

    expect(result).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(overlayNodes(parentWin.document)).toHaveLength(0);
  });

  test("rejects a staged commit when a child frame changes before commit", async () => {
    const parentWin = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    parentWin.document.body.innerHTML = `<button id="main-btn">Main action</button><iframe id="frame"></iframe>`;
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) throw new Error("parent fixture missing");
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 300, innerHeight: 200 });
    childWin.document.body.innerHTML = `<button id="child-btn">Child action</button>`;
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) throw new Error("child fixture missing");
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(
      childWin,
      [],
      [],
      new FakeElementHandle(iframe, parentWin, 101),
      null,
      () => 201,
    );
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { page } = fakePage(parentWin, "https://fixture.test/", session, [childFrame]);
    const deps: PageDeps = {
      connect: async () => fakeBrowser([page]),
      connectTab: async () => ({}) as never,
      timeoutMs: 100,
      snapshotStore: store,
    };
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const staged = await wrapper.stageObservation();
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw new Error("expected stage");

    session.emit("Page.frameNavigated", {
      frame: { id: CHILD_FRAME_ID, loaderId: "L2b", url: "https://child.test/next" },
      type: "Navigation",
    });

    const committed = wrapper.commitObservation(staged.staged);

    expect(committed).toEqual({
      ok: false,
      error: { code: "observation_failed", message: "Page observation failed" },
    });
    expect(
      store.lookup({ tabId: 7, snapshotId: "snap-1" as SnapshotId, ref: 1 }, { documentEpoch: 0, navigationEpoch: 0 }),
    ).toEqual({ ok: false, code: "stale_ref", target: expect.any(Object), reason: expect.any(String) });
  });
});