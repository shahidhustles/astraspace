import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Window } from "happy-dom";
import type { CDPSession, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { OBSERVE_PAGE_SOURCE, renderPageContent } from "../src/browser/observation";
import type { ExtractedPageContent, GroundingRecord, ObservedRef } from "../src/browser/observation";
import { FrameGraphTracker } from "../src/browser/document-identity";
import { SnapshotStore, type CommittedSnapshot } from "../src/browser/snapshot";
import { resolveTarget } from "../src/browser/target-resolution";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { GroundedTarget, ResolutionContext, TargetResolutionResult } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const MAIN_FRAME_ID = "main-1";
const CHILD_FRAME_ID = "child-1";

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8vLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQAAAAAAAQIDBAUGBwgJCgsQAAIBAgQEAwQHBQQEAAECAwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThFfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+hKKKK/qw/yTP//Z";

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

const FIXTURE_MULTILINE = `<!doctype html>
<html>
  <head><title>Resolution fixture</title></head>
  <body>
    <button id="save" aria-label="Save&#10;report"></button>
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
  multiline: {
    save: { x: 8, y: 8, width: 90, height: 28 },
  },
};

interface BackendRegistry {
  byElement: WeakMap<Element, number>;
  byId: Map<number, Element>;
  next: number;
}

const backendRegistries = new WeakMap<Window, BackendRegistry>();

function backendRegistry(win: Window): BackendRegistry {
  let registry = backendRegistries.get(win);
  if (!registry) {
    registry = { byElement: new WeakMap(), byId: new Map(), next: 1000 };
    backendRegistries.set(win, registry);
  }
  return registry;
}

function registerBackend(win: Window, el: Element): number {
  const registry = backendRegistry(win);
  let id = registry.byElement.get(el);
  if (id === undefined) {
    id = registry.next++;
    registry.byElement.set(el, id);
    registry.byId.set(id, el);
  }
  return id;
}

function elementForBackend(win: Window, id: number): Element | null {
  const element = backendRegistry(win).byId.get(id);
  return element && element.isConnected ? element : null;
}

function installXPath(win: Window): void {
  const doc = win.document as unknown as { evaluate?: unknown };
  if (doc.evaluate) {
    return;
  }
  (win as unknown as Record<string, unknown>).XPathResult = { ORDERED_NODE_SNAPSHOT_TYPE: 7 };
  (doc as unknown as Record<string, unknown>).evaluate = (expr: string, context: Node) => {
    const steps = expr.replace(/^\.\//, "").split("/").filter(Boolean);
    let nodes: Node[] = [context];
    for (const step of steps) {
      const match = /^([a-zA-Z][\w-]*)(?:\[(\d+)\])?$/.exec(step);
      if (!match) {
        return { snapshotLength: 0, snapshotItem: () => null };
      }
      const tag = match[1].toLowerCase();
      const index = match[2] ? Number(match[2]) : 1;
      const next: Node[] = [];
      for (const node of nodes) {
        const matching = [...(node as Element).children].filter(
          (child) => child.tagName.toLowerCase() === tag,
        );
        const el = matching[index - 1];
        if (el) {
          next.push(el);
        }
      }
      nodes = next;
      if (nodes.length === 0) {
        break;
      }
    }
    return {
      snapshotLength: nodes.length,
      snapshotItem: (i: number) => nodes[i] ?? null,
    };
  };
}

function fixtureWindow(name: "pair" | "single" | "twins" | "multiline"): Window {
  const fixtures = { pair: FIXTURE_PAIR, single: FIXTURE_SINGLE, twins: FIXTURE_TWINS, multiline: FIXTURE_MULTILINE };
  const win = new Window({
    url: "https://fixture.test/",
    innerWidth: VIEWPORT_WIDTH,
    innerHeight: VIEWPORT_HEIGHT,
  });
  win.document.write(fixtures[name]);
  win.document.close();
  installXPath(win);
  for (const [id, bounds] of Object.entries(LAYOUTS[name])) {
    const el = win.document.getElementById(id);
    if (!el) {
      throw new Error(`Fixture element #${id} not found`);
    }
    Object.defineProperty(el, "getBoundingClientRect", { value: () => bounds });
  }
  return win;
}

function shadowFixtureWindow(): Window {
  const win = new Window({
    url: "https://fixture.test/",
    innerWidth: VIEWPORT_WIDTH,
    innerHeight: VIEWPORT_HEIGHT,
  });
  win.document.write(
    "<!doctype html><html><head><title>Shadow fixture</title></head><body><div id=\"host\"></div></body></html>",
  );
  win.document.close();
  installXPath(win);
  const host = win.document.getElementById("host");
  if (!host) {
    throw new Error("Shadow fixture host missing");
  }
  Object.defineProperty(host, "getBoundingClientRect", {
    value: () => ({ x: 8, y: 8, width: 200, height: 100 }),
  });
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<button id="inner">Inner</button>`;
  const inner = root.querySelector("#inner");
  if (!inner) {
    throw new Error("Shadow fixture button missing");
  }
  Object.defineProperty(inner, "getBoundingClientRect", {
    value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
  });
  return win;
}

class FakeElementHandle {
  disposed = false;

  constructor(
    readonly element: Element | null,
    readonly win: Window,
    readonly backendNodeIdValue: number,
    readonly detachedFlag = false,
  ) {}

  async evaluate<T>(fn: (node: Node, ...args: unknown[]) => T, ...args: unknown[]): Promise<T> {
    if (this.detachedFlag) {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    }
    if (!this.element) {
      return null as T;
    }
    const source = fn.toString();
    const runner = new Function(
      "Element",
      "Node",
      "HTMLElement",
      "node",
      "args",
      `return (${source})(node, ...args);`,
    );
    return runner(this.win.Element, this.win.Node, this.win.HTMLElement, this.element, args) as T;
  }

  async backendNodeId(): Promise<number> {
    return this.backendNodeIdValue;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeFrame {
  evaluateCalls: string[] = [];
  functionCalls = 0;
  selectorCalls = 0;
  adoptCalls = 0;
  selectorError: Error | null = null;
  functionError: Error | null = null;
  selectorHook: (() => void) | null = null;
  detachAdoptOnce = false;
  detachAdoptAll = false;
  private adoptDetachConsumed = false;
  accessibilityCalls = 0;
  accessibility = {
    snapshot: async (_options: { root?: FakeElementHandle } = {}): Promise<Record<string, unknown> | null> => null,
  };

  constructor(
    readonly win: Window,
    readonly children: FakeFrame[] = [],
    readonly frameElementHandle: FakeElementHandle | null = null,
    readonly evaluateError: Error | null = null,
    readonly detachedFlag = false,
  ) {}

  get detached(): boolean {
    return this.detachedFlag;
  }

  childFrames(): FakeFrame[] {
    return this.children;
  }

  async frameElement(): Promise<FakeElementHandle | null> {
    return this.frameElementHandle;
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls.push(expression);
    if (this.evaluateError) {
      throw this.evaluateError;
    }
    const runner = new Function("window", "document", `return (${expression});`);
    return runner(this.win, this.win.document);
  }

  async evaluateHandle(fn: unknown, ...args: unknown[]): Promise<FakeHandleResult> {
    this.functionCalls += 1;
    if (this.functionError) {
      throw this.functionError;
    }
    const source = fn.toString();
    const runner = new Function(
      "window",
      "document",
      "Element",
      "ShadowRoot",
      "args",
      `return (${source})(...args);`,
    );
    const resolved = runner(this.win, this.win.document, this.win.Element, this.win.ShadowRoot, args) as unknown;
    const handleFor = (value: unknown): FakeHandleResult => ({
      asElement: () =>
        value instanceof this.win.Element && value.isConnected
          ? new FakeElementHandle(value, this.win, registerBackend(this.win, value))
          : null,
      getProperties: async () => {
        const properties = new Map<string, FakeHandleResult>();
        if (Array.isArray(value)) {
          for (const [index, item] of value.entries()) {
            properties.set(String(index), handleFor(item));
          }
        }
        return properties;
      },
      dispose: async () => {},
    });
    return {
      ...handleFor(resolved),
      dispose: async () => {},
    };
  }

  async $$(selector: string): Promise<FakeElementHandle[]> {
    this.selectorCalls += 1;
    this.selectorHook?.();
    if (this.selectorError) {
      throw this.selectorError;
    }
    return [...this.win.document.querySelectorAll(selector)].map(
      (el) => new FakeElementHandle(el, this.win, registerBackend(this.win, el)),
    );
  }

  mainRealm(): { adoptBackendNode: (backendNodeId: number) => Promise<FakeHandleResult> } {
    return {
      adoptBackendNode: async (backendNodeId: number) => {
        this.adoptCalls += 1;
        const el = elementForBackend(this.win, backendNodeId);
        if (!el) {
          return { asElement: () => null, dispose: async () => {} };
        }
        let detached = false;
        if (this.detachAdoptAll) {
          detached = true;
        } else if (this.detachAdoptOnce && !this.adoptDetachConsumed) {
          this.adoptDetachConsumed = true;
          detached = true;
        }
        return {
          asElement: () => new FakeElementHandle(el, this.win, backendNodeId, detached),
          dispose: async () => {},
        };
      },
    };
  }
}

interface FakeHandleResult {
  asElement: () => FakeElementHandle | null;
  getProperties?: () => Promise<Map<string, FakeHandleResult>>;
  dispose: () => Promise<void>;
}

interface FakePage extends Page {
  currentUrl: string;
  main: FakeFrame;
}

function fakePage(win: Window, main: FakeFrame, session: FakeSession, currentUrl = "https://fixture.test/"): FakePage {
  const accessibilitySnapshot = async ({ root }: { root?: FakeElementHandle } = {}) => {
    const element = root?.element ?? null;
    if (!element) {
      return null;
    }
    const tag = element.tagName.toLowerCase();
    const role =
      element.getAttribute("role") ??
      (tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? "textbox" : null);
    const rawName =
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (element.textContent ?? "").trim();
    const name = rawName?.replace(/\s+/g, " ").trim();
    return { role: role ?? undefined, name: name || undefined };
  };
  const emitter = new EventEmitter();
  const page = {
    currentUrl,
    main,
    url: () => page.currentUrl,
    createCDPSession: async () => session,
    _client: () => session,
    mainFrame: () => main,
    frames: () => [],
    on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
    goto: async (url: string) => {
      // A successful goto commits a new main-frame document.
      session.emit("Page.frameNavigated", {
        frame: { id: MAIN_FRAME_ID, loaderId: "L2", url },
        type: "Navigation",
      });
      return {};
    },
    title: async () => "Resolution fixture",
    accessibility: {
      snapshot: accessibilitySnapshot,
    },
    screenshot: async () => JPEG_BASE64,
  } as FakePage;
  const assignAccessibility = (frame: FakeFrame): void => {
    frame.accessibility.snapshot = async (options = {}) => {
      frame.accessibilityCalls += 1;
      return accessibilitySnapshot(options);
    };
    for (const child of frame.children) {
      assignAccessibility(child);
    }
  };
  assignAccessibility(main);
  return page;
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

function fakeBrowser(pages: Page[]): Page["browser"] {
  return {
    connected: true,
    pages: async () => pages,
    disconnect: async () => {},
    close: async () => {},
  } as Page["browser"];
}

function fakeDeps(
  win: Window,
  snapshotStore: SnapshotStore,
): { deps: PageDeps; page: FakePage; session: FakeSession; main: FakeFrame } {
  const session = new FakeSession();
  session.frameTree = mainFrameTree();
  const main = new FakeFrame(win);
  const page = fakePage(win, main, session);
  const deps: PageDeps = {
    connect: async () => fakeBrowser([page]),
    connectTab: async () => ({}) as never,
    timeoutMs: 100,
    snapshotStore,
  };
  return { deps, page, session, main };
}

async function resolutionContext(
  win: Window,
  session = new FakeSession(),
  children: FakeFrame[] = [],
): Promise<{ ctx: ResolutionContext; page: FakePage; main: FakeFrame; session: FakeSession }> {
  if (!session.frameTree) {
    session.frameTree = mainFrameTree();
  }
  const main = new FakeFrame(win, children, null, null, false);
  const page = fakePage(win, main, session);
  const tracker = await FrameGraphTracker.create(session as unknown as CDPSession);
  return {
    ctx: { page: page as unknown as Page, session: session as unknown as CDPSession, tracker },
    page,
    main,
    session,
  };
}

function sequencedUuids(): () => string {
  let next = 0;
  return () => `snap-${(next += 1)}`;
}

function captureRendered(win: Window): { refs: ObservedRef[]; groundings: GroundingRecord[] } {
  const extractFn = evaluateSource(OBSERVE_PAGE_SOURCE) as (
    win: Window,
    startRef: number,
    owners: Record<string, string>,
  ) => { content: ExtractedPageContent; nextRef: number };
  const { content } = extractFn(win, 1, {});
  const rendered = renderPageContent(content);
  return { refs: rendered.refs, groundings: rendered.groundings };
}

function evaluateSource(source: string): (...args: unknown[]) => unknown {
  return new Function(`return (${source});`)() as (...args: unknown[]) => unknown;
}

function observed(ref: number, tag: string, overrides: Partial<ObservedRef> = {}): ObservedRef {
  return { ref, tag, role: null, name: null, attrs: {}, bounds: null, ...overrides };
}

function grounding(ref: number, tag: string, overrides: Partial<GroundingRecord> = {}): GroundingRecord {
  return {
    ref,
    domPath: [],
    frameLineage: [],
    backendNodeId: null,
    cssSegments: [],
    xpathSegments: [],
    text: null,
    tag,
    role: null,
    name: null,
    attrs: {},
    disabled: false,
    bounds: null,
    ...overrides,
  };
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

function lineageStep(frameId: string, parentFrameId: string | null): GroundingRecord["frameLineage"][number] {
  return { frameId, parentFrameId, documentEpoch: 0, navigationEpoch: 0 };
}

function expectResolved(result: TargetResolutionResult): FakeElementHandle {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("expected success");
  }
  return result.element as FakeElementHandle;
}

describe("target resolution", () => {
  test("an older retained snapshot resolves its original element when a newer snapshot reused the ref", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const rendered = captureRendered(win);

    const firstPair = renumbered(rendered, 0, 1);
    const first = commit(store, firstPair.refs, firstPair.groundings);
    const secondPair = renumbered(rendered, 1, 1);
    const second = commit(store, secondPair.refs, secondPair.groundings);

    const fromFirst = expectResolved(await resolveTarget(ctx, store, target(first, 1)));
    const fromSecond = expectResolved(await resolveTarget(ctx, store, target(second, 1)));

    expect(await fromFirst.evaluate((el) => (el as Element).id)).toBe("save");
    expect(await fromSecond.evaluate((el) => (el as Element).id)).toBe("link");
    expect(fromFirst).not.toBe(fromSecond);
  });

  test("similar controls in different frames resolve only from their own grounded targets", async () => {
    const parentWin = new Window({ url: "https://fixture.test/", innerWidth: 800, innerHeight: 600 });
    parentWin.document.body.innerHTML = `<button id="main-btn">Save</button><iframe id="frame"></iframe>`;
    installXPath(parentWin);
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) {
      throw new Error("parent fixture missing");
    }
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Save</button>`;
    installXPath(childWin);
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) {
      throw new Error("child fixture missing");
    }
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], new FakeElementHandle(iframe, parentWin, 101));
    const { ctx, main } = await resolutionContext(parentWin, session, [childFrame]);
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const sharedIdentity = { role: "button", name: "Save", text: "Save" };
    const mainSnapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }],
          frameLineage: [lineageStep(MAIN_FRAME_ID, null)],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );
    const childSnapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }],
          frameLineage: [lineageStep(MAIN_FRAME_ID, null), lineageStep(CHILD_FRAME_ID, MAIN_FRAME_ID)],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );

    const fromMain = expectResolved(await resolveTarget(ctx, store, target(mainSnapshot, 1)));
    expect(await fromMain.evaluate((el) => (el as Element).id)).toBe("main-btn");

    const mainFunctionCalls = main.functionCalls;
    const mainSelectorCalls = main.selectorCalls;
    const mainAccessibilityCalls = main.accessibilityCalls;
    const fromChild = expectResolved(await resolveTarget(ctx, store, target(childSnapshot, 1)));
    expect(await fromChild.evaluate((el) => (el as Element).id)).toBe("child-btn");
    expect(main.functionCalls).toBe(mainFunctionCalls);
    expect(main.selectorCalls).toBe(mainSelectorCalls);
    expect(main.accessibilityCalls).toBe(mainAccessibilityCalls);
    expect(childFrame.accessibilityCalls).toBeGreaterThan(0);
  });

  test("a child-frame navigation stales only the child target before any locator runs", async () => {
    const parentWin = new Window({ url: "https://fixture.test/", innerWidth: 800, innerHeight: 600 });
    parentWin.document.body.innerHTML = `<button id="main-btn">Save</button><iframe id="frame"></iframe>`;
    installXPath(parentWin);
    const mainButton = parentWin.document.getElementById("main-btn");
    const iframe = parentWin.document.getElementById("frame");
    if (!mainButton || !iframe) {
      throw new Error("parent fixture missing");
    }
    Object.defineProperty(mainButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const childWin = new Window({ url: "https://child.test/", innerWidth: 400, innerHeight: 300 });
    childWin.document.body.innerHTML = `<button id="child-btn">Save</button>`;
    installXPath(childWin);
    const childButton = childWin.document.getElementById("child-btn");
    if (!childButton) {
      throw new Error("child fixture missing");
    }
    Object.defineProperty(childButton, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });

    const session = new FakeSession();
    session.frameTree = mainFrameTree([
      { frame: { id: CHILD_FRAME_ID, parentId: MAIN_FRAME_ID, loaderId: "L2", url: "https://child.test/" } },
    ]);
    session.ownerNodes.set(CHILD_FRAME_ID, 101);
    const childFrame = new FakeFrame(childWin, [], new FakeElementHandle(iframe, parentWin, 101));
    const { ctx, main } = await resolutionContext(parentWin, session, [childFrame]);
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const sharedIdentity = { role: "button", name: "Save", text: "Save" };
    const mainSnapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }],
          frameLineage: [lineageStep(MAIN_FRAME_ID, null)],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );
    const childSnapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }],
          frameLineage: [lineageStep(MAIN_FRAME_ID, null), lineageStep(CHILD_FRAME_ID, MAIN_FRAME_ID)],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );

    session.emit("Page.frameNavigated", {
      frame: { id: CHILD_FRAME_ID, loaderId: "L3", url: "https://child.test/page2" },
      type: "Navigation",
    });

    const stale = await resolveTarget(ctx, store, target(childSnapshot, 1));
    expect(stale).toEqual({
      ok: false,
      code: "stale_ref",
      target: expect.any(Object),
      reason: expect.any(String),
    });
    expect(childFrame.functionCalls).toBe(0);
    expect(childFrame.selectorCalls).toBe(0);

    const fromMain = expectResolved(await resolveTarget(ctx, store, target(mainSnapshot, 1)));
    expect(await fromMain.evaluate((el) => (el as Element).id)).toBe("main-btn");
    expect(main.selectorCalls).toBe(1);
  });

  test("prefers the live backend node when the recorded DOM path goes stale", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const save = win.document.getElementById("save");
    if (!save) {
      throw new Error("fixture missing");
    }
    const backendNodeId = registerBackend(win, save);
    const snapshot = commit(
      store,
      [observed(1, "button", { role: "button", name: "Save", attrs: { type: "submit" }, bounds: { x: 8, y: 8, width: 90, height: 28 } })],
      [
        grounding(1, "button", {
          role: "button",
          name: "Save",
          text: "Save",
          attrs: { type: "submit" },
          bounds: { x: 8, y: 8, width: 90, height: 28 },
          backendNodeId,
          domPath: [{ kind: "child", index: 0 }],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );

    const header = win.document.createElement("h1");
    header.textContent = "Header";
    win.document.body.insertBefore(header, win.document.getElementById("save"));

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));
    expect(await result.evaluate((el) => (el as Element).id)).toBe("save");
    expect(main.adoptCalls).toBe(1);
  });

  test("a rerender that moves the recorded element still resolves it", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const header = win.document.createElement("h1");
    header.textContent = "Header";
    win.document.body.insertBefore(header, win.document.getElementById("save"));

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));
    expect(await result.evaluate((el) => (el as Element).id)).toBe("save");
  });

  test("a replacement with the same tag and attributes but different text returns target_not_found", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const replacement = win.document.createElement("button");
    replacement.type = "submit";
    replacement.setAttribute("aria-label", "Save");
    replacement.textContent = "Save now";
    win.document.getElementById("save")?.replaceWith(replacement);

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
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
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const replacement = win.document.createElement("button");
    replacement.type = "submit";
    replacement.textContent = "Discard";
    win.document.getElementById("save")?.replaceWith(replacement);

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("bounds alone can never select a target", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const replacement = win.document.createElement("button");
    replacement.type = "submit";
    replacement.textContent = "Other";
    win.document.getElementById("save")?.replaceWith(replacement);

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("resolves a target whose allowed attributes contain a newline", async () => {
    const win = fixtureWindow("multiline");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));

    expect(await result.evaluate((el) => (el as Element).id)).toBe("save");
  });

  test("a control inside a shadow root resolves through its recorded shadow scope", async () => {
    const win = shadowFixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const sharedIdentity = { role: "button", name: "Inner", text: "Inner" };
    const snapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }, { kind: "shadow" }, { kind: "child", index: 0 }],
          cssSegments: ["div:nth-child(1)", "button:nth-child(1)"],
          xpathSegments: ["/div[1]", "/button[1]"],
        }),
      ],
    );

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));
    expect(await result.evaluate((el) => (el as Element).id)).toBe("inner");
  });

  test("a moved shadow control resolves inside its original shadow scope", async () => {
    const win = shadowFixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const sharedIdentity = { role: "button", name: "Inner", text: "Inner" };
    const snapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }, { kind: "shadow" }, { kind: "child", index: 0 }],
          cssSegments: ["div:nth-child(1)", "button:nth-child(1)"],
          xpathSegments: ["/div[1]", "/button[1]"],
        }),
      ],
    );
    const root = win.document.getElementById("host")?.shadowRoot;
    if (!root) throw new Error("shadow root missing");
    root.innerHTML = `<div><button id="moved">Inner</button></div>`;

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));

    expect(await result.evaluate((el) => (el as Element).id)).toBe("moved");
  });

  test("duplicate replacements inside a shadow scope return ambiguous_ref", async () => {
    const win = shadowFixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const sharedIdentity = { role: "button", name: "Inner", text: "Inner" };
    const snapshot = commit(
      store,
      [observed(1, "button", sharedIdentity)],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          domPath: [{ kind: "child", index: 0 }, { kind: "shadow" }, { kind: "child", index: 0 }],
          cssSegments: ["div:nth-child(1)", "button:nth-child(1)"],
          xpathSegments: ["/div[1]", "/button[1]"],
        }),
      ],
    );
    const root = win.document.getElementById("host")?.shadowRoot;
    if (!root) throw new Error("shadow root missing");
    root.innerHTML = `<button>Inner</button><button>Inner</button>`;

    const result = await resolveTarget(ctx, store, target(snapshot, 1));

    expect(result).toEqual({
      ok: false,
      code: "ambiguous_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("bounds fallback cannot escape the recorded shadow scope", async () => {
    const win = shadowFixtureWindow();
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const sharedIdentity = { role: "button", name: "Inner", text: "Inner" };
    const snapshot = commit(
      store,
      [observed(1, "button", { ...sharedIdentity, bounds: { x: 8, y: 8, width: 90, height: 28 } })],
      [
        grounding(1, "button", {
          ...sharedIdentity,
          bounds: { x: 8, y: 8, width: 90, height: 28 },
          domPath: [{ kind: "child", index: 0 }, { kind: "shadow" }, { kind: "child", index: 0 }],
          cssSegments: ["div:nth-child(1)", "button:nth-child(1)"],
          xpathSegments: ["/div[1]", "/button[1]"],
        }),
      ],
    );
    const root = win.document.getElementById("host")?.shadowRoot;
    if (!root) throw new Error("shadow root missing");
    root.innerHTML = "";
    const outside = win.document.createElement("button");
    outside.textContent = "Inner";
    Object.defineProperty(outside, "getBoundingClientRect", {
      value: () => ({ x: 8, y: 8, width: 90, height: 28 }),
    });
    win.document.body.appendChild(outside);

    const result = await resolveTarget(ctx, store, target(snapshot, 1));

    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("missing accessibility data cannot bypass recorded semantics", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));
    main.accessibility.snapshot = async () => null;

    const result = await resolveTarget(ctx, store, target(snapshot, 1));

    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("more than one verified candidate returns ambiguous_ref with no element", async () => {
    const win = fixtureWindow("twins");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "ambiguous_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("a detached first candidate causes exactly one fresh resolution attempt", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const save = win.document.getElementById("save");
    if (!save) {
      throw new Error("fixture missing");
    }
    const snapshot = commit(
      store,
      [observed(1, "button", { role: "button", name: "Save", attrs: { type: "submit" } })],
      [
        grounding(1, "button", {
          role: "button",
          name: "Save",
          text: "Save",
          attrs: { type: "submit" },
          backendNodeId: registerBackend(win, save),
          domPath: [{ kind: "child", index: 0 }],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );
    main.detachAdoptOnce = true;

    const result = expectResolved(await resolveTarget(ctx, store, target(snapshot, 1)));
    expect(await result.evaluate((el) => (el as Element).id)).toBe("save");
    expect(main.adoptCalls).toBe(2);
  });

  test("a persistently detached candidate returns target_not_found after two passes", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const save = win.document.getElementById("save");
    if (!save) {
      throw new Error("fixture missing");
    }
    const snapshot = commit(
      store,
      [observed(1, "button", { role: "button", name: "Save", attrs: { type: "submit" } })],
      [
        grounding(1, "button", {
          role: "button",
          name: "Save",
          text: "Save",
          attrs: { type: "submit" },
          backendNodeId: registerBackend(win, save),
          domPath: [{ kind: "child", index: 0 }],
          cssSegments: ["button:nth-child(1)"],
          xpathSegments: ["/button[1]"],
        }),
      ],
    );
    main.detachAdoptAll = true;

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
    expect(main.adoptCalls).toBe(2);
  });

  test("an invalidated snapshot returns stale_ref without touching the DOM", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));
    store.invalidate(7);

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "stale_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
    expect(main.functionCalls).toBe(0);
    expect(main.selectorCalls).toBe(0);
    expect(main.adoptCalls).toBe(0);
  });

  test("an epoch-mismatched snapshot returns stale_ref", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win), {
      documentEpoch: 2,
      navigationEpoch: 2,
    });

    const result = await resolveTarget(ctx, store, target(snapshot, 1));
    expect(result).toEqual({
      ok: false,
      code: "stale_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("returns stale_ref when navigation begins during live resolution", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, session, main } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));
    main.selectorHook = () => {
      session.emit("Page.frameNavigated", {
        frame: { id: MAIN_FRAME_ID, loaderId: "L2", url: "https://fixture.test/page2" },
        type: "Navigation",
      });
      store.invalidate(7);
    };

    const result = await resolveTarget(ctx, store, target(snapshot, 1));

    expect(result).toEqual({
      ok: false,
      code: "stale_ref",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
  });

  test("normalizes a locator failure to target_not_found", async () => {
    const win = fixtureWindow("single");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { ctx, main } = await resolutionContext(win);
    const snapshot = commitRendered(store, captureRendered(win));
    main.selectorError = new Error("Execution context was destroyed");

    const result = await resolveTarget(ctx, store, target(snapshot, 1));

    expect(result).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(snapshot, 1),
      reason: expect.any(String),
    });
    expect(main.selectorCalls).toBe(2);
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
    const { deps, main, session } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");
    const functionCalls = main.functionCalls;

    session.emit("Page.frameNavigated", {
      frame: { id: MAIN_FRAME_ID, loaderId: "L2", url: "https://fixture.test/page2" },
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
    expect(main.functionCalls).toBe(functionCalls);
    expect(main.selectorCalls).toBe(0);
  });

  test("returns stale_ref after a same-document navigation without touching the DOM", async () => {
    const win = fixtureWindow("pair");
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const { deps, main, session } = fakeDeps(win, store);
    const wrapper = new BrowserPage(7, "https://fixture.test/", deps);
    await wrapper.attach();
    const observed = await wrapper.observe();
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error("expected success");
    const functionCalls = main.functionCalls;

    session.emit("Page.navigatedWithinDocument", {
      frameId: MAIN_FRAME_ID,
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
    expect(main.functionCalls).toBe(functionCalls);
    expect(main.selectorCalls).toBe(0);
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
