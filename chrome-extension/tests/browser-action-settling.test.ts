import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import puppeteer, { type Browser, type Frame, type HTTPRequest, type Page } from "puppeteer-core";
import {
  DomActivityWatcher,
  domObserverCountSource,
  domObserverInstallSource,
  domObserverUninstallSource,
} from "../src/browser/waits/dom";
import { NetworkActivityWatcher } from "../src/browser/waits/network";
import { TabActionCoordinator } from "../src/browser/waits/coordinator";
import type { SettleTimings } from "../src/browser/waits/types";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  handleBrowserRuntimeMessage,
  OBSERVE_SELECTED_TAB_MESSAGE,
  type BrowserRuntime,
} from "../src/browser/runtime";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { BrowserContext } from "../src/browser/context";
import type { BrowserState, GroundedTarget } from "../src/browser/types";

const FAST_TIMINGS: SettleTimings = { domQuietMs: 60, networkQuietMs: 80, pollMs: 10 };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRequest(resourceType: string, frame?: Frame): HTTPRequest {
  return { resourceType: () => resourceType, frame: () => frame ?? null } as unknown as HTTPRequest;
}

function fakeNetworkPage(): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return emitter;
}

function resourceTypeOf(name: string): string {
  return name;
}

describe("NetworkActivityWatcher", () => {
  test("reports quiet once the tracked request finishes", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    const request = fakeRequest(resourceTypeOf("fetch"));
    page.emit("request", request);
    await sleep(10);
    page.emit("requestfinished", request);

    const signal = await watcher.waitForQuiet(500);
    expect(signal.status).toBe("quiet");
    if (signal.status === "quiet") {
      expect(signal.ignoredRequests).toBe(0);
      expect(signal.idleMs).toBeGreaterThanOrEqual(FAST_TIMINGS.networkQuietMs);
    }
    watcher.dispose();
    expect(page.listenerCount("request")).toBe(0);
    expect(page.listenerCount("requestfinished")).toBe(0);
    expect(page.listenerCount("requestfailed")).toBe(0);
  });

  test("removes tracking when a request fails instead of finishing", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    const request = fakeRequest(resourceTypeOf("xhr"));
    page.emit("request", request);
    await sleep(5);
    page.emit("requestfailed", request);

    const signal = await watcher.waitForQuiet(500);
    expect(signal.status).toBe("quiet");
    watcher.dispose();
  });

  test("counts long-lived excluded requests without letting them block quiet", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    for (const kind of ["websocket", "eventsource", "media", "other"]) {
      page.emit("request", fakeRequest(kind));
    }

    const signal = await watcher.waitForQuiet(500);
    expect(signal.status).toBe("quiet");
    if (signal.status === "quiet") {
      expect(signal.ignoredRequests).toBe(4);
    }
    watcher.dispose();
  });

  test("times out with a pending count while a tracked request never settles", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    page.emit("request", fakeRequest(resourceTypeOf("script")));
    page.emit("request", fakeRequest(resourceTypeOf("websocket")));

    const signal = await watcher.waitForQuiet(40);
    expect(signal).toEqual({ status: "activity_timeout", timeoutMs: 40, pendingCount: 1, ignoredRequests: 1 });
    watcher.dispose();
  });

  test("does not report quiet while a tracked request outlives the quiet interval", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    page.emit("request", fakeRequest(resourceTypeOf("fetch")));

    const signal = await watcher.waitForQuiet(140);

    expect(signal).toEqual({ status: "activity_timeout", timeoutMs: 140, pendingCount: 1, ignoredRequests: 0 });
    watcher.dispose();
  });

  test("a committed main frame retires obsolete document requests from earlier hops", async () => {
    const page = fakeNetworkPage();
    const oldChild = { parentFrame: () => ({}) } as unknown as Frame;
    const mainFrame = { parentFrame: () => null } as unknown as Frame;
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    page.emit("request", fakeRequest(resourceTypeOf("document"), mainFrame));
    page.emit("request", fakeRequest(resourceTypeOf("document"), oldChild));

    page.emit("framenavigated", mainFrame);
    const signal = await watcher.waitForQuiet(500);

    expect(signal.status).toBe("quiet");
    watcher.dispose();
  });

  test("resolves cancelled as soon as the abort signal fires", async () => {
    const page = fakeNetworkPage();
    const watcher = NetworkActivityWatcher.arm(page as unknown as Page, FAST_TIMINGS);
    page.emit("request", fakeRequest(resourceTypeOf("document")));

    const controller = new AbortController();
    const waiting = watcher.waitForQuiet(2_000, controller.signal);
    controller.abort();
    const signal = await waiting;
    expect(signal.status).toBe("cancelled");
    watcher.dispose();
  });
});

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
  private readonly scope: DomScope | null;

  constructor(scope: DomScope | null) {
    this.scope = scope;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async evaluate(...args: unknown[]): Promise<unknown> {
    if (!this.scope) {
      throw new Error("frame detached");
    }
    const source = args[0];
    if (typeof source !== "string") {
      throw new Error("test shim only evaluates string sources");
    }
    return this.scope.run(source);
  }
}

function fakeDomPage(frames: FakeFrame[]): {
  emitter: EventEmitter;
  page: Page;
} {
  const emitter = new EventEmitter();
  const holder = { frames };
  const page = {
    frames: () => holder.frames,
    on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn),
    off: (event: string, fn: (...args: unknown[]) => void) => emitter.off(event, fn),
  } as unknown as Page;
  return { emitter, page };
}

describe("DomActivityWatcher", () => {
  test("measures mutations across a live frame and reports quiet", async () => {
    const scope = makeDomScope();
    const frame = new FakeFrame(scope);
    const { emitter, page } = fakeDomPage([frame]);
    const watcher = await DomActivityWatcher.arm(page, FAST_TIMINGS);

    const installedBefore = scope.win.__astraDomWatch?.active;
    expect(installedBefore).toBe(true);

    const waiting = watcher.waitForQuiet(1_000);
    await sleep(5);
    const item = scope.win.document.createElement("div");
    scope.win.document.body.appendChild(item);

    const signal = await waiting;
    expect(signal.status).toBe("quiet");
    if (signal.status === "quiet") {
      expect(signal.watchedFrames).toBe(1);
      expect(signal.idleMs).toBeGreaterThanOrEqual(FAST_TIMINGS.domQuietMs);
    }
    expect(scope.run(domObserverCountSource())).toBeGreaterThan(0);

    watcher.dispose();
    await sleep(0);
    expect(emitter.listenerCount("framedetached")).toBe(0);
    expect(scope.run(domObserverUninstallSource())).toBe(false);
  });

  test("skips frames it cannot reach", async () => {
    const reachable = new FakeFrame(makeDomScope());
    const dead = new FakeFrame(null);
    const { page } = fakeDomPage([dead, reachable]);
    const watcher = await DomActivityWatcher.arm(page, FAST_TIMINGS);

    const signal = await watcher.waitForQuiet(500);
    expect(signal.status).toBe("quiet");
    if (signal.status === "quiet") {
      expect(signal.watchedFrames).toBe(1);
    }
    watcher.dispose();
  });

  test("drops detached frames from observation", async () => {
    const scope = makeDomScope();
    const frame = new FakeFrame(scope);
    const { emitter, page } = fakeDomPage([frame]);
    const watcher = await DomActivityWatcher.arm(page, FAST_TIMINGS);

    emitter.emit("framedetached", frame);
    const signal = await watcher.waitForQuiet(500);
    expect(signal.status).toBe("quiet");
    if (signal.status === "quiet") {
      expect(signal.watchedFrames).toBe(0);
    }
    watcher.dispose();
  });

  test("uninstall source reports already-inactive state honestly", () => {
    const scope = makeDomScope();
    expect(scope.run(domObserverInstallSource())).toBe(true);
    expect(scope.run(domObserverUninstallSource())).toBe(true);
    expect(scope.run(domObserverUninstallSource())).toBe(false);
    expect(scope.run(domObserverCountSource())).toBe(-1);
  });
});

describe("coordinator settle budget", () => {
  test("threads remaining caller timeout into dispatched work", async () => {
    const coordinator = new TabActionCoordinator();
    let seenTimeout: number | null | "unset" = "unset";
    const scheduled = coordinator.enqueue({
      tabId: 1,
      name: "browser_type",
      deadlineMs: 120,
      work: (_signal, budget) => {
        seenTimeout = budget.timeoutMs;
        return Promise.resolve({
          ok: true,
          action: "browser_type",
          tabId: 1,
          url: "https://example.com",
          snapshotInvalidated: true,
          data: { kind: "type" },
        });
      },
    });
    await scheduled.settled;
    expect(seenTimeout).not.toBe("unset");
    expect(seenTimeout as number).toBeLessThanOrEqual(120);
    expect(seenTimeout as number).toBeGreaterThan(90);
  });

  test("passes a null budget when no explicit timeout was requested", async () => {
    const coordinator = new TabActionCoordinator();
    let seenTimeout: number | null | "unset" = "unset";
    const scheduled = coordinator.enqueue({
      tabId: 1,
      name: "browser_keypress",
      work: (_signal, budget) => {
        seenTimeout = budget.timeoutMs;
        return Promise.resolve({
          ok: false,
          action: "browser_keypress",
          tabId: null,
          error: { code: "selected_tab_unavailable", message: "none" },
        });
      },
    });
    await scheduled.settled;
    expect(seenTimeout).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Runtime layer against a real Chrome. Proves edits only return after their
// induced fetch responses and DOM renders go quiet.
// ---------------------------------------------------------------------------

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-action-waits.html");

// The waits fixture embeds this page in its expectation frame.
const CHILD_HTML = `<!doctype html><html><body>
<div id="child-marker">Child ready</div>
<div id="child-removable" role="status">Frame status</div>
</body></html>`;

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

interface SuggestionPayload {
  items: string[];
}

describe("edit actions settle through the runtime boundary", () => {
  const TAB_ID = 4;

  let browser: Browser | null = null;
  let page: Page | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let wsPinger: ReturnType<typeof setInterval> | null = null;
  let fixtureUrl: string;
  let runtime: BrowserRuntime;

  beforeAll(async () => {
    if (!chromePath) {
      throw new Error("Chrome is required. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    const html = await Bun.file(FIXTURE_PATH).text();

    server = Bun.serve({
      port: 0,
      fetch: async (request, upgradeServer) => {
        const url = new URL(request.url);
        if (url.pathname === "/child.html") {
          return new Response(CHILD_HTML, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname === "/ws") {
          const upgraded = upgradeServer.upgrade(request);
          return upgraded ? undefined : new Response("upgrade failed", { status: 500 });
        }
        if (url.pathname.startsWith("/respond")) {
          const kind = url.searchParams.get("kind");
          if (kind === "suggest") {
            await sleep(300);
            const items: SuggestionPayload["items"] = ["Green suggestion", "Red suggestion"];
            return new Response(JSON.stringify(items), {
              headers: { "content-type": "application/json" },
            });
          }
        }
        if (url.pathname === "/pixel.png") {
          const pixels = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            "base64",
          );
          return new Response(pixels, { headers: { "content-type": "image/png" } });
        }
        return new Response(html, {
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        });
      },
      websocket: {
        open(ws) {
          ws.subscribe("ws-life");
        },
        message() {},
      },
    });
    wsPinger = setInterval(() => {
      server?.publish("ws-life", "tick");
    }, 150);
    fixtureUrl = `http://127.0.0.1:${server.port}/`;

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });
    [page] = await browser.pages();
    await page.goto(fixtureUrl, { waitUntil: "load" });

    const context = new BrowserContext({
      queryActiveTab: async () => [{ id: TAB_ID, url: fixtureUrl, title: "Waits fixture" }],
      queryTabs: async () => [],
      createTab: async (url) => ({ id: 99, url, title: "Opened" }),
      updateTab: async (tabId) => ({ id: tabId, url: fixtureUrl, title: "Waits fixture" }),
      removeTab: async () => {},
      onUpdated: () => () => {},
      onActivated: () => () => {},
      onRemoved: () => () => {},
      onDetach: () => () => {},
      pageDeps: {
        connect: async () => browser as unknown as Awaited<ReturnType<typeof connect>>,
        connectTab: async () => ({}) as never,
        timeoutMs: 10_000,
      },
      timeoutMs: 10_000,
    });
    runtime = context as unknown as BrowserRuntime;
    const attached = await handleBrowserRuntimeMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }, runtime);
    expect(attached).toEqual({ ok: true, tabId: TAB_ID });
  }, 30_000);

  afterAll(async () => {
    if (wsPinger) {
      clearInterval(wsPinger);
    }
    if (browser?.connected) {
      await browser.close();
    }
    server?.stop(true);
  });

  async function freshPage(): Promise<void> {
    await page!.goto(fixtureUrl, { waitUntil: "load" });
  }

  async function observe(): Promise<BrowserState> {
    const result = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);
    if (!result || !result.ok) {
      throw new Error(`observation failed: ${JSON.stringify(result)}`);
    }
    return result.state;
  }

  function refByName(state: BrowserState, name: string): BrowserState["refs"][number] {
    const ref = state.refs.find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`no observed ref named ${name}`);
    }
    return ref;
  }

  function targetFor(state: BrowserState, name: string): GroundedTarget {
    const ref = refByName(state, name);
    return { tabId: TAB_ID, snapshotId: state.snapshotId, ref: ref.ref };
  }

  function jsonSafe(result: unknown): void {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  }

  function textIn(selector: string): Promise<string> {
    return page!.evaluate((query) => document.querySelector(query)?.textContent ?? "", selector);
  }

  test(
    "typed edit waits out its delayed fetch and DOM render, then reports signals",
    async () => {
      await freshPage();
      const state = await observe();
      const target = targetFor(state, "Suggest input");

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_type",
          input: { target, text: "gr" },
          wait: { timeoutMs: 8_000 },
        },
        runtime,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.action).toBe("browser_type");
      expect(result.data).toEqual({ kind: "type" });
      expect(result.snapshotInvalidated).toBe(true);
      expect(result.signals?.network.status).toBe("quiet");
      expect(result.signals?.dom.status).toBe("quiet");
      jsonSafe(result);

      const suggestionCount = await page!.evaluate(
        () => document.querySelectorAll("#suggest-list li").length,
      );
      expect(suggestionCount).toBe(2);
      expect(await textIn("#log")).toContain("rendered:2");

      // Settlement uninstalled its DOM observer once the signals were read.
      const observerStillLive = await page!.evaluate(
        () => (window as Record<string, { active?: boolean }>).__astraDomWatch?.active ?? false,
      );
      expect(observerStillLive).toBe(false);

      // The consumed snapshot must stay invalid after dispatch.
      const staleProbe = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input: { target, text: "more" } },
        runtime,
      );
      expect(staleProbe.ok).toBe(false);
      if (!staleProbe.ok) {
        expect(staleProbe.error.code).toBe("stale_ref");
      }
    },
    30_000,
  );

  test(
    "a failing fetch leaves nothing pending and still settles quietly",
    async () => {
      await freshPage();
      const state = await observe();
      const target = targetFor(state, "Fail input");

      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input: { target, text: "x" } },
        runtime,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.signals?.network.status).toBe("quiet");
      if (result.signals?.network.status !== "quiet") {
        throw new Error("expected network quiet");
      }
      expect(result.signals.dom.status).toBe("quiet");
      expect(await textIn("#log")).toContain("fetch-failed");
    },
    30_000,
  );

  test(
    "a permanent websocket shows up only as ignored-request evidence",
    async () => {
      await freshPage();
      const state = await observe();
      const target = targetFor(state, "Ws input");

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_type",
          input: { target, text: "go" },
          wait: { timeoutMs: 8_000 },
        },
        runtime,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.signals?.network.status).toBe("quiet");
      if (result.signals?.network.status !== "quiet") {
        throw new Error("expected network quiet despite websocket");
      }
      expect(result.signals.network.ignoredRequests).toBeGreaterThanOrEqual(1);

      const wsReady = await page!.evaluate(() => (window as Record<string, number>).__wsReadyState);
      expect(wsReady).toBe(1);
    },
    30_000,
  );

  test(
    "selection-driven DOM churn reports measured signals and rendered chips",
    async () => {
      await freshPage();
      const state = await observe();
      const target = targetFor(state, "Chip select");

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target, index: 1, label: "Green chip", value: "green" },
        },
        runtime,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.data).toEqual({ kind: "select_option", selectedIndex: 1 });
      expect(result.signals?.dom.status).toBe("quiet");
      expect(result.signals?.network.status).toBe("quiet");
      jsonSafe(result);

      const chipCount = await page!.evaluate(() => document.querySelectorAll("#chips span").length);
      expect(chipCount).toBe(2);
      expect(await textIn("#log")).toContain("chips-rendered:green");
    },
    30_000,
  );

  test(
    "clear and keypress edits report signals and keep snapshots invalid",
    async () => {
      await freshPage();
      const typed = await observe();
      const suggestTarget = targetFor(typed, "Suggest input");

      const pressed = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_keypress",
          input: {
            key: "a",
            modifiers: { alt: false, control: false, meta: false, shift: false },
            target: suggestTarget,
          },
        },
        runtime,
      );
      expect(pressed.ok).toBe(true);
      if (!pressed.ok) {
        throw new Error(JSON.stringify(pressed));
      }
      expect(pressed.signals?.network.status).toBe("quiet");
      expect(pressed.signals?.dom.status).toBe("quiet");
      const keyValue = await page!.evaluate(
        () => (document.getElementById("suggest-input") as HTMLInputElement).value,
      );
      expect(keyValue).toBe("a");

      const recleared = await observe();
      const clearTarget = targetFor(recleared, "Suggest input");
      const cleared = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: clearTarget },
        runtime,
      );
      expect(cleared.ok).toBe(true);
      if (!cleared.ok) {
        throw new Error(JSON.stringify(cleared));
      }
      expect(cleared.signals?.dom.status).toBe("quiet");
      const clearValue = await page!.evaluate(
        () => (document.getElementById("suggest-input") as HTMLInputElement).value,
      );
      expect(clearValue).toBe("");

      const stale = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_get_select_options",
          input: clearTarget,
        },
        runtime,
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error.code).toBe("stale_ref");
      }
    },
    30_000,
  );

  test(
    "an edit-triggered navigation reports its commit and enforces the final URL policy",
    async () => {
      await freshPage();
      await page!.evaluate(() => {
        document.getElementById("suggest-input")?.addEventListener(
          "input",
          () => setTimeout(() => location.assign("?edit-navigation=1"), 0),
          { once: true },
        );
      });
      const navigatedState = await observe();
      const navigated = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_type",
          input: { target: targetFor(navigatedState, "Suggest input"), text: "n" },
        },
        runtime,
      );

      expect(navigated.ok).toBe(true);
      if (!navigated.ok) {
        throw new Error(JSON.stringify(navigated));
      }
      expect(navigated.url).toContain("edit-navigation=1");
      expect(navigated.signals?.commits?.some((commit) => commit.kind === "main_commit")).toBe(true);

      await freshPage();
      await page!.evaluate(() => {
        document.getElementById("suggest-input")?.addEventListener(
          "input",
          () => setTimeout(() => location.assign("about:blank"), 0),
          { once: true },
        );
      });
      const redirectedState = await observe();
      const redirected = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_type",
          input: { target: targetFor(redirectedState, "Suggest input"), text: "x" },
        },
        runtime,
      );

      expect(redirected.ok).toBe(false);
      if (redirected.ok) {
        throw new Error("unsupported edit redirect was reported as success");
      }
      expect(redirected.error.code).toBe("unsupported_redirect");
      expect(redirected.completion?.dispatchStarted).toBe(true);
    },
    30_000,
  );
});
