import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { FrameGraphTracker } from "../src/browser/document-identity";
import { BrowserPage } from "../src/browser/page";
import { domObserverCountSource, domObserverUninstallSource } from "../src/browser/waits/dom";
import { NavigationWatcher } from "../src/browser/waits/navigation";
import type { CommitWaitOutcome, SettleTimings } from "../src/browser/waits/types";

const FAST_TIMINGS: SettleTimings = { domQuietMs: 60, networkQuietMs: 80, pollMs: 10 };

const MAIN_FRAME_ID = "main-1";
const SUB_FRAME_ID = "sub-1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Fake CDP session and fake page, mirroring the harness style used by the
// document-identity and action-settling suites.
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter {
  detached = false;
  frameTree: { frame: Record<string, unknown>; childFrames?: unknown[] } | null = null;

  async send(method: string): Promise<unknown> {
    if (method === "Page.enable") {
      return {};
    }
    if (method === "Page.getFrameTree") {
      if (!this.frameTree) {
        throw new Error("no frame tree configured");
      }
      return { frameTree: this.frameTree };
    }
    throw new Error(`unexpected send: ${method}`);
  }

  async detach(): Promise<void> {
    this.detached = true;
  }
}

function frame(id: string, loaderId: string, url = "https://fixture.test/", parentId?: string): Record<string, unknown> {
  return { id, loaderId, url, ...(parentId ? { parentId } : {}) };
}

async function trackerFor(session: FakeSession): Promise<FrameGraphTracker> {
  session.frameTree = {
    frame: frame(MAIN_FRAME_ID, "L1"),
    childFrames: [{ frame: frame(SUB_FRAME_ID, "L-sub", "https://fixture.test/child", MAIN_FRAME_ID) }],
  };
  return FrameGraphTracker.create(session as never);
}

interface DomScope {
  win: Window;
  run: (source: string) => unknown;
}

function makeDomScope(): DomScope {
  const win = new Window();
  const run = (source: string): unknown =>
    new Function("window", "document", "MutationObserver", `"use strict"; return ${source};`)(
      win,
      win.document,
      win.MutationObserver,
    );
  return { win, run };
}

class FakeFrame {
  scope: DomScope | null;

  constructor(scope: DomScope | null) {
    this.scope = scope;
  }

  async evaluate(source: string): Promise<unknown> {
    if (!this.scope) {
      throw new Error("execution context was destroyed");
    }
    return this.scope.run(source);
  }
}

function fakePage(frames: FakeFrame[]): { emitter: EventEmitter; page: Page } {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const holder = { frames };
  const page = {
    frames: () => holder.frames,
    on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
  } as unknown as Page;
  return { emitter, page };
}

function emitMainCommit(session: FakeSession, loaderId: string, url: string): void {
  session.emit("Page.frameNavigated", { frame: frame(MAIN_FRAME_ID, loaderId, url), type: "Navigation" });
}

function emitSameDocument(session: FakeSession, url: string): void {
  session.emit("Page.navigatedWithinDocument", { frameId: MAIN_FRAME_ID, url, navigationType: "fragment" });
}

function jsonSafe(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

describe("FrameGraphTracker commit records", () => {
  test("a main-frame commit reports old and final URLs with bumped epochs", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const seen: unknown[] = [];
    const unsubscribe = tracker.onCommit((record) => seen.push(record));

    session.emit("Page.frameNavigated", { frame: frame(MAIN_FRAME_ID, "L2", "https://fixture.test/page2"), type: "Navigation" });
    unsubscribe();

    expect(seen.length).toBe(1);
    const record = seen[0] as Record<string, unknown>;
    expect(record.kind).toBe("main_commit");
    expect(record.frameId).toBe(MAIN_FRAME_ID);
    expect(record.parentFrameId).toBeNull();
    expect(record.oldUrl).toBe("https://fixture.test/");
    expect(record.newUrl).toBe("https://fixture.test/page2");
    expect(record.loaderId).toBe("L2");
    expect(tracker.identity).toEqual({ documentEpoch: 1, navigationEpoch: 1 });
  });

  test("a same-document route change bumps only the navigation epoch", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const seen: unknown[] = [];
    tracker.onCommit((record) => seen.push(record));

    emitSameDocument(session, "https://fixture.test/#route");

    expect(seen.length).toBe(1);
    const record = seen[0] as Record<string, unknown>;
    expect(record.kind).toBe("same_document");
    expect(record.oldUrl).toBe("https://fixture.test/");
    expect(record.newUrl).toBe("https://fixture.test/#route");
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 1 });
  });

  test("a child-frame navigation carries its parent id without touching the root identity", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const seen: unknown[] = [];
    tracker.onCommit((record) => seen.push(record));

    session.emit("Page.frameNavigated", {
      frame: frame(SUB_FRAME_ID, "L-sub2", "https://fixture.test/child#next", MAIN_FRAME_ID),
      type: "Navigation",
    });

    expect(seen.length).toBe(1);
    const record = seen[0] as Record<string, unknown>;
    expect(record.kind).toBe("child_commit");
    expect(record.frameId).toBe(SUB_FRAME_ID);
    expect(record.parentFrameId).toBe(MAIN_FRAME_ID);
    expect(tracker.identity).toEqual({ documentEpoch: 0, navigationEpoch: 0 });
  });

  test("an unsubscribed listener stops receiving commits", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    let calls = 0;
    const unsubscribe = tracker.onCommit(() => {
      calls += 1;
    });
    unsubscribe();

    emitMainCommit(session, "L2", "https://fixture.test/page2");

    expect(calls).toBe(0);
  });
});

describe("NavigationWatcher", () => {
  test("captures an immediate commit with evidence, then quiet signals", async () => {
    const scope = makeDomScope();
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const { emitter, page } = fakePage([new FakeFrame(scope)]);
    const watcher = await NavigationWatcher.arm(page, tracker, FAST_TIMINGS);

    const waiting = watcher.waitForCommit({ acceptsSameDocument: false }, 1_000);
    emitMainCommit(session, "L2", "https://fixture.test/page2");
    const outcome = await waiting;

    expect(outcome.status).toBe("matched");
    if (outcome.status !== "matched") {
      throw new Error(JSON.stringify(outcome));
    }
    expect(outcome.match.kind).toBe("main_commit");
    expect(watcher.allCommits().map((record) => record.kind)).toEqual(["main_commit"]);
    jsonSafe(watcher.allCommits());

    const signals = await watcher.waitForQuiet(500);
    expect(signals.network.status).toBe("quiet");
    expect(signals.dom.status).toBe("quiet");
    if (signals.dom.status === "quiet") {
      expect(signals.dom.watchedFrames).toBe(1);
    }
    jsonSafe(signals);

    watcher.dispose();
    await sleep(0);
    expect(emitter.listenerCount("request")).toBe(0);
    expect(emitter.listenerCount("requestfinished")).toBe(0);
    expect(emitter.listenerCount("requestfailed")).toBe(0);
    expect(scope.run(domObserverUninstallSource())).toBe(false);
  });

  test("a navigate does not complete on a same-document signal alone", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const { page } = fakePage([new FakeFrame(makeDomScope())]);
    const watcher = await NavigationWatcher.arm(page, tracker, FAST_TIMINGS);

    const waiting: Promise<CommitWaitOutcome> = watcher.waitForCommit({ acceptsSameDocument: false }, 60);
    emitSameDocument(session, "https://fixture.test/#route");
    const outcome = await waiting;

    expect(outcome.status).toBe("timeout");
    if (outcome.status === "timeout") {
      expect(watcher.allCommits().length).toBe(1);
      expect(outcome.timeoutMs).toBe(60);
    }
    watcher.dispose();
  });

  test("back completes on a same-document signal when accepted", async () => {
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const { page } = fakePage([new FakeFrame(makeDomScope())]);
    const watcher = await NavigationWatcher.arm(page, tracker, FAST_TIMINGS);

    const waiting = watcher.waitForCommit({ acceptsSameDocument: true }, 500);
    emitSameDocument(session, "https://fixture.test/#route");
    const outcome = await waiting;

    expect(outcome.status).toBe("matched");
    if (outcome.status === "matched") {
      expect(outcome.match.kind).toBe("same_document");
    }
    watcher.dispose();
  });

  test("reinstalls a DOM observer after the frame's context is destroyed", async () => {
    const scopeA = makeDomScope();
    const first = new FakeFrame(scopeA);
    const session = new FakeSession();
    const tracker = await trackerFor(session);
    const holder = { frames: [first] };
    const emitter = new EventEmitter();
    const page = {
      frames: () => holder.frames,
      on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
      off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
    } as unknown as Page;
    const watcher = await NavigationWatcher.arm(page, tracker, FAST_TIMINGS);

    const waiting = watcher.waitForQuiet(2_000);

    // Real churn on the first document so quiet needs a fresh tail.
    await sleep(20);
    scopeA.win.document.body.appendChild(scopeA.win.document.createElement("div"));

    // Kill the first execution context and bring a second one up in its place.
    await sleep(15);
    const scopeB = makeDomScope();
    first.scope = scopeB;

    // Churn on the replacement document must be seen through the reinstall.
    await sleep(30);
    scopeB.win.document.body.appendChild(scopeB.win.document.createElement("section"));

    const outcome = await waiting;
    expect(outcome.dom.status).toBe("quiet");
    if (outcome.dom.status === "quiet") {
      expect(outcome.dom.watchedFrames).toBe(1);
    }
    expect(scopeA.run(domObserverCountSource())).toBeGreaterThan(0);
    expect(scopeB.run(domObserverUninstallSource())).toBe(true);

    watcher.dispose();
    await sleep(0);
    expect(scopeB.run(domObserverUninstallSource())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runtime layer against a real Chrome. Proves navigations report their
// committed document, recorded hops, and the quiet state that followed.
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const cacheRoot = join(homedir(), ".cache", "puppeteer");
  if (!existsSync(cacheRoot)) {
    return null;
  }
  const executables = new Set(["chrome", "headless_shell", "Google Chrome for Testing"]);
  for (const match of new Bun.Glob("**/*").scanSync({ cwd: cacheRoot, onlyFiles: true })) {
    if (executables.has(match.split("/").pop() ?? "")) {
      return join(cacheRoot, match);
    }
  }
  return null;
}

const chromePath = findChrome();

const CHILD_HTML = `<!doctype html><html><body><div id="child-marker">Child ready</div></body></html>`;

function fixtureServer(fixtureHtml: string, port = 0): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/child.html") {
        return new Response(CHILD_HTML, { headers: { "content-type": "text/html" } });
      }
      return new Response(fixtureHtml, {
        headers: { "content-type": "text/html", "cache-control": "no-store" },
      });
    },
  });
}

describe("navigation actions settle through the runtime boundary", () => {
  const TAB_ID = 7;

  let browser: Browser | null = null;
  let rawPage: Page | null = null;
  let primaryServer: ReturnType<typeof Bun.serve> | null = null;
  let crossServer: ReturnType<typeof Bun.serve> | null = null;
  let base: string;
  let crossBase: string;
  let wrapper: BrowserPage;

  beforeAll(async () => {
    if (!chromePath) {
      throw new Error("Chrome is required. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    const html = await Bun.file(join(import.meta.dir, "fixtures", "browser-action-waits.html")).text();
    primaryServer = fixtureServer(html);
    base = `http://127.0.0.1:${primaryServer.port}`;
    crossServer = fixtureServer(CHILD_HTML);
    crossBase = `http://127.0.0.1:${crossServer.port}`;

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 800, height: 600 },
    });
    [rawPage] = await browser.pages();
    await rawPage.goto(`${base}/`, { waitUntil: "load" });

    wrapper = new BrowserPage(TAB_ID, `${base}/`, {
      connect: async () => browser as never,
      connectTab: async () => ({}) as never,
      timeoutMs: 10_000,
      settleTimings: FAST_TIMINGS,
    });
    const attached = await wrapper.attach();
    expect(attached).toEqual({ ok: true, tabId: TAB_ID });
  }, 30_000);

  afterAll(async () => {
    if (wrapper.attached) {
      await wrapper.disconnect();
    }
    if (browser?.connected) {
      await browser.close();
    }
    primaryServer?.stop(true);
    crossServer?.stop(true);
  });

  test(
    "a navigate proves its commit, final URL, and quiet conditions",
    async () => {
      const target = `${base}/?entry=a`;
      const result = await wrapper.navigate(target);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(target);
      expect(result.commitType).toBe("commit");
      expect(result.documentEpoch).toBeGreaterThanOrEqual(1);
      expect(result.navigationEpoch).toBeGreaterThanOrEqual(1);
      expect(result.commits.length).toBeGreaterThanOrEqual(1);
      expect(result.signals.network.status).toBe("quiet");
      expect(result.signals.dom.status).toBe("quiet");
      expect(JSON.parse(JSON.stringify(result.commits))).toEqual(result.commits);
    },
    30_000,
  );

  test(
    "back over a pushed route completes on a same-document commit, not load or URL equality",
    async () => {
      const before = await wrapper.navigate(`${base}/?entry=b`);
      if (!before.ok) {
        throw new Error(JSON.stringify(before));
      }

      await rawPage!.evaluate(() => history.pushState({ route: "#route" }, "", "#route"));

      const result = await wrapper.goBack();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/?entry=b`);
      expect(result.commitType).toBe("same_document");
      // The document never swapped, so its epoch stands; the route change
      // moved the navigation epoch forward.
      expect(result.documentEpoch).toBe(before.documentEpoch);
      expect(result.navigationEpoch).toBeGreaterThan(before.navigationEpoch);
      expect(result.signals.dom.status).toBe("quiet");
      expect(result.signals.network.status).toBe("quiet");
    },
    30_000,
  );

  test(
    "refresh lands a fresh main-frame document commit on the same URL",
    async () => {
      const before = await wrapper.navigate(`${base}/?entry=c`);
      if (!before.ok) {
        throw new Error(JSON.stringify(before));
      }

      const result = await wrapper.reload();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/?entry=c`);
      expect(result.commitType).toBe("commit");
      expect(result.documentEpoch).toBe(before.documentEpoch + 1);
      expect(result.signals.network.status).toBe("quiet");
      expect(result.signals.dom.status).toBe("quiet");
    },
    30_000,
  );

  test(
    "a child-frame navigation contributes frame evidence and leaves no dead observer behind",
    async () => {
      // The same-origin child loads inside this navigation's own window, so
      // its commit and its document request land in the reported evidence.
      const start = await wrapper.navigate(`${base}/?child=${encodeURIComponent(`${base}/child.html`)}`);
      expect(start.ok).toBe(true);
      if (!start.ok) {
        throw new Error(JSON.stringify(start));
      }
      const firstChild = start.commits.find((commit) => commit.kind === "child_commit");
      expect(firstChild).toBeDefined();
      expect(firstChild?.parentFrameId).toBeTruthy();
      expect(firstChild?.newUrl).toBe(`${base}/child.html`);
      expect(start.signals.network.status).toBe("quiet");

      // Swap the child to a second origin while a reload window is open, so
      // the old context dies mid-measurement and the replacement is observed.
      const settling = wrapper.reload();
      await sleep(120);
      await rawPage!.evaluate((url) => window.__swapChildSrc(url), `${crossBase}/cross-child.html`);
      const swapped = await settling;
      expect(swapped.ok).toBe(true);
      if (!swapped.ok) {
        throw new Error(JSON.stringify(swapped));
      }
      const swappedChild = swapped.commits.find(
        (commit) => commit.kind === "child_commit" && commit.newUrl.startsWith(crossBase),
      );
      expect(swappedChild).toBeDefined();
      expect(swapped.signals.dom.status).toBe("quiet");

      // One more full settle proves every watcher survived the swaps.
      const onceMore = await wrapper.reload();
      expect(onceMore.ok).toBe(true);
      if (!onceMore.ok) {
        throw new Error(JSON.stringify(onceMore));
      }
      expect(onceMore.signals.dom.status).toBe("quiet");

      const frameAlive = await rawPage!.evaluate(() => Boolean(document.querySelector("#iframe-host iframe")));
      expect(frameAlive).toBe(true);
    },
    30_000,
  );

  test(
    "a multi-hop navigation records every hop and settles on the last document",
    async () => {
      // The second hop rides through its own real navigation while the first
      // document's settle window is still open.
      const settling = wrapper.navigate(`${base}/?entry=hop`);
      await sleep(15);
      await rawPage!.goto(`${base}/`, { waitUntil: "load" });
      const result = await settling;

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/`);
      expect(result.commits.length).toBeGreaterThanOrEqual(2);
      expect(result.commits[0].newUrl).toContain("entry=hop");
      expect(result.commits[result.commits.length - 1].newUrl).toBe(`${base}/`);
      expect(result.commits[result.commits.length - 1].oldUrl).toContain("entry=hop");
      expect(result.signals.network.status).toBe("quiet");
      expect(result.signals.dom.status).toBe("quiet");
    },
    30_000,
  );
});
