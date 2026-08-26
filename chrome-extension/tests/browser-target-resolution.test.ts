import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Window } from "happy-dom";
import type { Browser, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { OBSERVE_PAGE_SOURCE, renderPageContent } from "../src/browser/observation";
import type { ExtractedPageContent, GroundingRecord, ObservedRef } from "../src/browser/observation";
import { SnapshotStore, type CommittedSnapshot } from "../src/browser/snapshot";
import { resolveTarget } from "../src/browser/target-resolution";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThFfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+hKKKK/qw/yTP//Z";

const FIXTURE_PAIR = `<!doctype html>
<html>
  <head><title>Resolution fixture</title></head>
  <body>
    <button id="save" type="submit">Save</button>
    <a id="link" href="https://example.com">Read more</a>
  </body>
</html>`;

const FIXTURE_SINGLE = `<!doctype html>
<html>
  <head><title>Resolution fixture</title></head>
  <body>
    <button id="save" type="submit">Save</button>
  </body>
</html>`;

const FIXTURE_TWINS = `<!doctype html>
<html>
  <head><title>Resolution fixture</title></head>
  <body>
    <button id="save-a" type="submit">Save</button>
    <button id="save-b" type="submit">Save</button>
  </body>
</html>`;

const LAYOUTS: Record<string, Record<string, { x: number; y: number; width: number; height: number }>> = {
  pair: {
    save: { x: 8, y: 8, width: 90, height: 28 },
    link: { x: 8, y: 48, width: 90, height: 16 },
  },
  single: {
    save: { x: 8, y: 8, width: 90, height: 28 },
  },
  twins: {
    "save-a": { x: 8, y: 8, width: 90, height: 28 },
    "save-b": { x: 8, y: 48, width: 90, height: 28 },
  },
};

function fixtureWindow(name: "pair" | "single" | "twins"): Window {
  const fixtures = { pair: FIXTURE_PAIR, single: FIXTURE_SINGLE, twins: FIXTURE_TWINS };
  const win = new Window({
    url: "https://fixture.test/",
    innerWidth: VIEWPORT_WIDTH,
    innerHeight: VIEWPORT_HEIGHT,
  });
  win.document.write(fixtures[name]);
  win.document.close();
  for (const [id, bounds] of Object.entries(LAYOUTS[name])) {
    const el = win.document.getElementById(id);
    if (!el) {
      throw new Error(`Fixture element #${id} not found`);
    }
    Object.defineProperty(el, "getBoundingClientRect", { value: () => bounds });
  }
  return win;
}

function evaluateSource(source: string): (...args: unknown[]) => unknown {
  return new Function(`return (${source});`)() as (...args: unknown[]) => unknown;
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "element" in value) {
    return (value as { element: unknown }).element;
  }
  return value;
}

function runInDom(fn: (...args: unknown[]) => unknown, win: Window, args: unknown[]): unknown {
  const recreated = new Function(
    "Element",
    "Node",
    "HTMLElement",
    `return (${fn.toString()});`,
  );
  return recreated(win.Element, win.Node, win.HTMLElement)(...args);
}

interface FakeHandle {
  element: Element | null;
  asElement: () => FakeHandle | null;
  evaluate: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  dispose: () => Promise<void>;
}

interface FakePage extends Page {
  currentUrl: string;
  evaluateCalls: number;
  selectorCalls: number;
  evaluateError: Error | null;
}

function elementHandle(win: Window, element: Element | null): FakeHandle {
  return {
    element,
    asElement: () => (element ? elementHandle(win, element) : null),
    evaluate: async (fn: (...args: unknown[]) => unknown, ...args: unknown[]) =>
      runInDom(fn, win, [element, ...args.map(unwrap)]),
    dispose: async () => {},
  };
}

function fakePage(win: Window, session?: FakeSession, currentUrl = "https://fixture.test/"): FakePage {
  const page = {
    currentUrl,
    evaluateCalls: 0,
    selectorCalls: 0,
    evaluateError: null,
    url: () => page.currentUrl,
    createCDPSession: async () => session ?? new FakeSession(),
    goto: async () => ({}),
    evaluate: async (expression: unknown, ...args: unknown[]): Promise<unknown> => {
      page.evaluateCalls += 1;
      if (page.evaluateError) {
        throw page.evaluateError;
      }
      if (typeof expression === "function") {
        return runInDom(expression as (...fnArgs: unknown[]) => unknown, win, args.map(unwrap));
      }
      const runner = new Function("window", "document", `return (${expression as string});`);
      return runner(win, win.document);
    },
    evaluateHandle: async (_fn: unknown, domPath: number[]) => {
      let node: Node | null = win.document.body;
      for (const index of domPath) {
        node = node?.childNodes.item(index) ?? null;
      }
      return elementHandle(win, node instanceof win.Element ? node : null);
    },
    $$: async (selector: string) => {
      page.selectorCalls += 1;
      return [...win.document.querySelectorAll(selector)].map((el) => elementHandle(win, el));
    },
    accessibility: {
      snapshot: async ({ root }: { root?: FakeHandle } = {}) => {
        const element = root?.element ?? null;
        if (!element) {
          return null;
        }
        const tag = element.tagName.toLowerCase();
        const role =
          element.getAttribute("role") ??
          (tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? "textbox" : null);
        const name =
          (element.textContent ?? "").trim() || element.getAttribute("aria-label") || element.getAttribute("title");
        return { role: role ?? undefined, name: name || undefined };
      },
    },
    title: async () => "Resolution fixture",
    screenshot: async () => JPEG_BASE64,
  } as FakePage;
  return page;
}

class FakeSession extends EventEmitter {
  detached = false;
  sent: string[] = [];

  async send(method: string): Promise<unknown> {
    this.sent.push(method);
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-1", loaderId: "L1", url: "https://fixture.test/" } } };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function fakeBrowser(pages: Page[]): Browser {
  return {
    connected: true,
    pages: async () => pages,
    disconnect: async () => {},
    close: async () => {},
  } as Browser;
}

function fakeDeps(
  win: Window,
  snapshotStore: SnapshotStore,
): { deps: PageDeps; page: FakePage; session: FakeSession } {
  const session = new FakeSession();
  const page = fakePage(win, session);
  const browser = fakeBrowser([page]);
  const deps: PageDeps = {
    connect: async () => browser,
    connectTab: async () => ({}) as never,
    timeoutMs: 100,
    snapshotStore,
  };
  return { deps, page, session };
}

function sequencedUuids(): () => string {
  let next = 0;
  return () => `snap-${(next += 1)}`;
}

function captureRendered(win: Window): { refs: ObservedRef[]; groundings: GroundingRecord[] } {
  const extractFn = evaluateSource(OBSERVE_PAGE_SOURCE) as (win: Window) => ExtractedPageContent;
  const rendered = renderPageContent(extractFn(win));
  return { refs: rendered.refs, groundings: rendered.groundings };
}

function commit(
  store: SnapshotStore,
  refs: ObservedRef[],
  groundings: GroundingRecord[],
  overrides: Partial<{ documentEpoch: number; navigationEpoch: number }> = {},
): CommittedSnapshot {
  const result = store.commit({
    tabId: 7,
    documentEpoch: overrides.documentEpoch ?? 0,
    navigationEpoch: overrides.navigationEpoch ?? 0,
    dom: "<document>",
    refs,
    groundings,
  });
  if (!result.ok) {
    throw new Error(`expected commit success, got ${result.code}`);
  }
  return result.snapshot;
}

function renumbered(rendered: { refs: ObservedRef[]; groundings: GroundingRecord[] }, index: number, ref: number): {
  refs: ObservedRef[];
  groundings: GroundingRecord[];
} {
  return {
    refs: [{ ...rendered.refs[index], ref }],
    groundings: [{ ...rendered.groundings[index], ref }],
  };
}

function commitRendered(
  store: SnapshotStore,
  rendered: { refs: ObservedRef[]; groundings: GroundingRecord[] },
  overrides: Partial<{ documentEpoch: number; navigationEpoch: number }> = {},
): CommittedSnapshot {
  return commit(store, rendered.refs, rendered.groundings, overrides);
}

function target(snapshot: CommittedSnapshot, ref: number): GroundedTarget {
  return { tabId: 7, snapshotId: snapshot.identity.snapshotId, ref };
}

const LIVE = { documentEpoch: 0, navigationEpoch: 0 };

function expectResolved(result: TargetResolutionResult): FakeHandle {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  return result.element as FakeHandle;
}

describe("target resolution", () => {
  test("an older retained snapshot resolves its original element when a newer snapshot reused the ref", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const rendered = captureRendered(win);

    const firstPair = renumbered(rendered, 0, 1);
    const first = commit(store, firstPair.refs, firstPair.groundings);
    const secondPair = renumbered(rendered, 1, 1);
    const second = commit(store, secondPair.refs, secondPair.groundings);

    const fromFirst = expectResolved(await resolveTarget(page, store, target(first, 1), LIVE));
    const fromSecond = expectResolved(await resolveTarget(page, store, target(second, 1), LIVE));

    expect(await fromFirst.evaluate((el) => (el as Element).id)).toBe("save");
    expect(await fromSecond.evaluate((el) => (el as Element).id)).toBe("link");
    expect(fromFirst).not.toBe(fromSecond);
  });

  test("replacing the element at the recorded DOM path returns target_not_found", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win));

    win.document.getElementById("save")?.replaceWith(win.document.createElement("div"));

    const result = await resolveTarget(page, store, target(snapshot, 1), LIVE);
    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("a replacement with the same tag but a different accessible name returns target_not_found", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const replacement = win.document.createElement("button");
    replacement.type = "submit";
    replacement.textContent = "Discard";
    win.document.getElementById("save")?.replaceWith(replacement);

    const result = await resolveTarget(page, store, target(snapshot, 1), LIVE);
    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("a rerender that moves the recorded element still resolves it", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const header = win.document.createElement("h1");
    header.textContent = "Header";
    win.document.body.insertBefore(header, win.document.getElementById("save"));

    const result = expectResolved(await resolveTarget(page, store, target(snapshot, 1), LIVE));
    expect(await result.evaluate((el) => (el as Element).id)).toBe("save");
  });

  test("more than one verified candidate returns ambiguous_ref with no element", async () => {
    const win = fixtureWindow("twins");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const result = await resolveTarget(page, store, target(snapshot, 1), LIVE);
    expect(result).toEqual({
      ok: false,
      code: "ambiguous_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("an invalidated snapshot returns stale_ref without touching the DOM", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win));
    store.invalidate(7);

    const result = await resolveTarget(page, store, target(snapshot, 1), LIVE);
    expect(result).toEqual({
      ok: false,
      code: "stale_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
    expect(page.evaluateCalls).toBe(0);
    expect(page.selectorCalls).toBe(0);
  });

  test("an epoch-mismatched snapshot returns stale_ref", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const page = fakePage(win);
    const snapshot = commitRendered(store, captureRendered(win), {
      documentEpoch: 2,
      navigationEpoch: 2,
    });

    const result = await resolveTarget(page, store, target(snapshot, 1), { documentEpoch: 0, navigationEpoch: 0 });
    expect(result).toEqual({
      ok: false,
      code: "stale_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });
});

describe("BrowserPage.resolveTarget", () => {
  test("resolves a target from a committed observation against the live page", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");

    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: observed.state.snapshotId,
      ref: 1,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected success");
    expect(await resolved.element.evaluate((el) => (el as Element).id)).toBe("save");
  });

  test("returns target_not_found after the recorded element is replaced", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();

    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");

    win.document.getElementById("save")?.replaceWith(win.document.createElement("div"));
    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: observed.state.snapshotId,
      ref: 1,
    });
    expect(resolved).toEqual({
      ok: false,
      code: "target_not_found",
      target: expect.any(Object),
      reason: expect.any(String),
    });
  });

  test("returns stale_ref when the page is not attached", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);

    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: "snap-1" as GroundedTarget["snapshotId"],
      ref: 1,
    });
    expect(resolved).toEqual({
      ok: false,
      code: "stale_ref",
      target: expect.any(Object),
      reason: expect.any(String),
    });
  });

  test("returns stale_ref after an external navigation without touching the DOM", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, page, session } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");
    const evaluateCalls = page.evaluateCalls;

    session.emit("Page.frameNavigated", {
      frame: { id: "main-1", loaderId: "L2", url: "https://fixture.test/page2" },
      type: "Navigation",
    });
    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: observed.state.snapshotId,
      ref: 1,
    });

    expect(resolved).toEqual({
      ok: false,
      code: "stale_ref",
      target: expect.any(Object),
      reason: expect.any(String),
    });
    expect(page.evaluateCalls).toBe(evaluateCalls);
    expect(page.selectorCalls).toBe(0);
  });

  test("returns stale_ref after a same-document navigation without touching the DOM", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, page, session } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");
    const evaluateCalls = page.evaluateCalls;

    session.emit("Page.navigatedWithinDocument", {
      frameId: "main-1",
      url: "https://fixture.test/#section",
    });
    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: observed.state.snapshotId,
      ref: 1,
    });

    expect(resolved).toEqual({
      ok: false,
      code: "stale_ref",
      target: expect.any(Object),
      reason: expect.any(String),
    });
    expect(page.evaluateCalls).toBe(evaluateCalls);
    expect(page.selectorCalls).toBe(0);
  });

  test("returns stale_ref after a dispatched navigation and resolves again after re-observation", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, page } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");

    page.currentUrl = "https://fixture.test/other";
    await wrapper.navigate("https://fixture.test/other");

    const stale = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: observed.state.snapshotId,
      ref: 1,
    });
    expect(stale).toEqual({
      ok: false,
      code: "stale_ref",
      target: expect.any(Object),
      reason: expect.any(String),
    });

    const refreshed = await wrapper.observe();
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error("expected success");
    const resolved = await wrapper.resolveTarget({
      tabId: 7,
      snapshotId: refreshed.state.snapshotId,
      ref: 1,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected success");
    expect(await resolved.element.evaluate((el) => (el as Element).id)).toBe("save");
  });
});