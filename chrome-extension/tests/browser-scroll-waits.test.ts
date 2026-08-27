import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  handleBrowserRuntimeMessage,
  OBSERVE_SELECTED_TAB_MESSAGE,
  type BrowserRuntime,
} from "../src/browser/runtime";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { BrowserContext } from "../src/browser/context";
import { BrowserPage } from "../src/browser/page";
import type { BrowserState, GroundedTarget } from "../src/browser/types";

const FAST_TIMINGS = {
  domQuietMs: 60,
  networkQuietMs: 80,
  pollMs: 10,
  layoutSampleSpanMs: 100,
  layoutTolerancePx: 2,
};

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Late CDP responses can reject after their suite's browser closed. These
// transport-close races carry no test meaning; everything else still fails
// loudly.
function isBenignTeardownError(reason: unknown): boolean {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return message.includes("Target closed") || message.includes("Protocol error");
}

function installTeardownNet(): (reason: unknown) => void {
  const handler = (reason: unknown): void => {
    if (!isBenignTeardownError(reason)) {
      console.error(reason);
    }
  };
  process.on("unhandledRejection", handler);
  return handler;
}

function removeTeardownNet(handler: (reason: unknown) => void): void {
  process.off("unhandledRejection", handler);
}

describe("scroll settlement through the runtime boundary", () => {
  const TAB_ID = 21;
  let teardownNet: ((reason: unknown) => void) | null = null;

  let browser: Browser | null = null;
  let rawPage: Page | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base: string;
  let wrapper: BrowserPage;

  beforeAll(async () => {
    if (!chromePath) {
      throw new Error("Chrome is required. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    teardownNet = installTeardownNet();
    const html = await Bun.file(join(import.meta.dir, "fixtures", "browser-action-waits.html")).text();
    server = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(html, {
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        }),
    });
    base = `http://127.0.0.1:${server.port}`;

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox"],
      // Tall enough that the fixture's scroller and control blocks render
      // together in the initial viewport, keeping grounded refs observable.
      defaultViewport: { width: 800, height: 1600 },
    });
    [rawPage] = await browser.pages();
    await rawPage.goto(base, { waitUntil: "load" });

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
    // Let any in-flight page callbacks land before the transport dies.
    await sleep(60);
    try {
      if (wrapper?.attached) {
        await wrapper.disconnect();
      }
    } catch {
      // Teardown racing a closing transport is noise, not a test failure.
    }
    if (browser?.connected) {
      await browser.close();
    }
    server?.stop(true);
    if (teardownNet) {
      removeTeardownNet(teardownNet);
      teardownNet = null;
    }
  });

  async function freshPage(): Promise<void> {
    await rawPage!.goto(base, { waitUntil: "load" });
    await rawPage!.evaluate((clean) => history.replaceState(null, "", clean), base);
    await sleep(30);
  }

  async function state(): Promise<BrowserState> {
    const staged = await wrapper.stageObservation();
    expect(staged.ok).toBe(true);
    if (!staged.ok) {
      throw new Error(JSON.stringify(staged));
    }
    const committed = wrapper.commitObservation(staged.staged);
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      throw new Error(JSON.stringify(committed));
    }
    return committed.state;
  }

  function targetFor(snap: BrowserState, name: string): GroundedTarget {
    const ref = snap.refs.find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`no observed ref named ${name}`);
    }
    return { tabId: TAB_ID, snapshotId: snap.snapshotId, ref: ref.ref };
  }

  function call(name: string, arg?: number): Promise<void> {
    return rawPage!.evaluate(
      ({ fixtureName, value }) => {
        const fn = (window as unknown as Record<string, (a?: number) => void>)[fixtureName];
        fn?.(value);
      },
      { fixtureName: name, value: arg },
    );
  }

  function readNumber(expression: () => number): Promise<number> {
    return rawPage!.evaluate(expression);
  }

  async function assertNoLeaks(name: string): Promise<void> {
    const observerLive = await rawPage!.evaluate(
      () => (window as Record<string, { active?: boolean }>).__astraDomWatch?.active ?? false,
    );
    expect(observerLive, `${name}: DOM observer left installed`).toBe(false);
    const detachedCount = (rawPage as unknown as { listenerCount: (event: string) => number }).listenerCount(
      "framedetached",
    );
    expect(detachedCount, `${name}: leaked framedetached listener`).toBe(0);
  }

  test(
    "document edge scrolling reports reached-and-stable coordinates",
    async () => {
      await freshPage();
      const maxY = await readNumber(() => {
        const el = document.scrollingElement!;
        return Math.max(0, el.scrollHeight - window.innerHeight);
      });

      const bottom = await wrapper.scroll({ mode: { mode: "bottom" } }, settleCtx(6_000));
      expect(bottom.ok).toBe(true);
      if (!bottom.ok || !bottom.measurement) {
        throw new Error(JSON.stringify(bottom));
      }
      expect(Math.abs(bottom.position.y - maxY)).toBeLessThanOrEqual(FAST_TIMINGS.layoutTolerancePx);
      expect(bottom.measurement.stability?.status).toBe("stable");
      expect(bottom.measurement.signals?.network.status).toBe("quiet");
      expect(bottom.measurement.signals?.dom.status).toBe("quiet");

      // Percentage of the same range lands mid-document and settles too.
      const percent = await wrapper.scroll({ mode: { mode: "percent", percent: 50 } }, settleCtx(6_000));
      expect(percent.ok).toBe(true);
      if (!percent.ok || !percent.measurement) {
        throw new Error(JSON.stringify(percent));
      }
      expect(percent.position.y).toBe(Math.round((maxY * 50) / 100));
      expect(percent.measurement.stability?.status).toBe("stable");
      expect(JSON.parse(JSON.stringify(percent))).toEqual(percent);
    },
    20_000,
  );

  test(
    "paged scrolling moves one viewport and settles",
    async () => {
      await freshPage();
      const paged = await wrapper.scroll({ mode: { mode: "page_down" } }, settleCtx(6_000));
      expect(paged.ok).toBe(true);
      if (!paged.ok || !paged.measurement) {
        throw new Error(JSON.stringify(paged));
      }
      expect(paged.position.y).toBeGreaterThan(0);
      expect(paged.measurement.stability?.status).toBe("stable");

      const backUp = await wrapper.scroll({ mode: { mode: "top" } }, settleCtx(6_000));
      expect(backUp.ok).toBe(true);
      if (!backUp.ok) {
        throw new Error(JSON.stringify(backUp));
      }
      expect(backUp.position.y).toBeLessThanOrEqual(FAST_TIMINGS.layoutTolerancePx);
    },
    20_000,
  );

  test(
    "grounded container scrolling stabilizes inside its own scroller",
    async () => {
      await freshPage();
      const snap = await state();
      const target = targetFor(snap, "Box anchor");
      const expected = await readNumber(() => {
        const box = document.getElementById("scroll-box")!;
        return Math.max(0, box.scrollHeight - box.clientHeight);
      });

      const result = await wrapper.scroll({ mode: { mode: "bottom" }, target }, settleCtx(6_000));
      expect(result.ok).toBe(true);
      if (!result.ok || !result.measurement) {
        throw new Error(JSON.stringify(result));
      }
      expect(Math.abs(result.position.y - expected)).toBeLessThanOrEqual(FAST_TIMINGS.layoutTolerancePx);
      expect(result.measurement.stability?.status).toBe("stable");
      assertNoLeaks("container-scroll");
    },
    20_000,
  );

  test(
    "visible-text scrolling completes after lazy rows extend the quiet window",
    async () => {
      await freshPage();
      const startedAt = Date.now();
      const pending = wrapper.scrollToText("Deep scroll marker two", 1, settleCtx(8_000));
      // Insert rows synchronously once the barrier is running so completion
      // must cover the DOM quiet window behind the insertion.
      await rawPage!.evaluate(() => {
        const box = document.getElementById("scroll-box");
        if (!box) {
          throw new Error("scroll-box missing");
        }
        for (let i = 0; i < 20; i++) {
          const row = document.createElement("div");
          row.className = "row";
          row.textContent = `Injected row ${Date.now()}-${i}`;
          box.appendChild(row);
        }
        (window as unknown as { __lastLazyInsertAt: number }).__lastLazyInsertAt = Date.now();
      });
      const result = await pending;
      const doneAt = Date.now();

      expect(result.ok).toBe(true);
      if (!result.ok || !result.measurement) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.measurement.stability?.status).toBe("stable");
      expect(result.position.y).toBeGreaterThan(0);

      // The burst landed mid-barrier; completion waited out the DOM quiet
      // window behind it instead of finishing before the rows arrived.
      const lazyAt = await readNumber(() => Number(window.__lastLazyInsertAt ?? 0));
      expect(lazyAt).toBeGreaterThan(startedAt);
      expect(lazyAt).toBeLessThanOrEqual(doneAt);
      expect(doneAt - lazyAt).toBeGreaterThanOrEqual(FAST_TIMINGS.domQuietMs - 15);
      assertNoLeaks("text-scroll");
    },
    25_000,
  );

  test(
    "a scripted scroll lock yields bounded unsettled evidence instead of hanging",
    async () => {
      await freshPage();
      const snap = await state();
      const target = targetFor(snap, "Box anchor");
      await call("__lockScrollTo", 0);
      try {
        const startedAt = Date.now();
        const result = await wrapper.scroll({ mode: { mode: "bottom" }, target }, settleCtx(700));
        const elapsed = Date.now() - startedAt;

        expect(result.ok).toBe(true);
        if (!result.ok || !result.measurement) {
          throw new Error(JSON.stringify(result));
        }
        const stability = result.measurement.stability;
        expect(stability?.status).toBe("unsettled");
        if (stability?.status !== "unsettled") {
          throw new Error(JSON.stringify(stability));
        }
        expect(["unstable", "unreachable"]).toContain(stability.reason);
        expect(elapsed).toBeLessThan(700 + 2_500);
        assertNoLeaks("scroll-lock");
      } finally {
        await call("__releaseScrollLock");
      }
    },
    20_000,
  );

  test(
    "a removed container returns bounded evidence and never re-resolves",
    async () => {
      await freshPage();
      const snap = await state();
      const target = targetFor(snap, "Box anchor");
      // Arming makes the container remove itself on the first scroll event,
      // so the settle barrier probes a surface that vanishes mid-wait.
      await call("__removeScrollBox");

      const startedAt = Date.now();
      const result = await wrapper.scroll({ mode: { mode: "bottom" }, target }, settleCtx(4_000));
      const elapsed = Date.now() - startedAt;

      expect(elapsed).toBeLessThan(6_000);
      if (result.ok) {
        expect(result.measurement?.stability?.status).toBe("unsettled");
        if (result.measurement?.stability?.status === "unsettled") {
          expect(result.measurement.stability.reason).toBe("unreachable");
        }
      } else {
        expect(result.error.code).toBe("action_failed");
      }
      assertNoLeaks("container-removed");
    },
    20_000,
  );
});

// Coordinator-level flows run on a dedicated browser: one context stack per
// session, mirroring the single-attach pattern the click waits suite uses.
describe("coordinator-level scroll cancellation and evidence", () => {
  const TAB_ID = 22;

  let browser: Browser | null = null;
  let rawPage: Page | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base: string;
  let runtime: BrowserRuntime;
  let teardownNet: ((reason: unknown) => void) | null = null;

  beforeAll(async () => {
    if (!chromePath) {
      throw new Error("Chrome is required. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    teardownNet = installTeardownNet();
    const html = await Bun.file(join(import.meta.dir, "fixtures", "browser-action-waits.html")).text();
    server = Bun.serve({
      port: 0,
      fetch: async () =>
        new Response(html, {
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        }),
    });
    base = `http://127.0.0.1:${server.port}`;

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 800, height: 1600 },
    });
    [rawPage] = await browser.pages();
    await rawPage.goto(base, { waitUntil: "load" });

    const context = new BrowserContext({
      queryActiveTab: async () => [{ id: TAB_ID, url: `${base}/`, title: "Waits fixture" }],
      queryTabs: async () => [],
      createTab: async (url) => ({ id: 98, url, title: "Opened" }),
      updateTab: async (tabId) => ({ id: tabId, url: `${base}/`, title: "Waits fixture" }),
      removeTab: async () => {},
      onUpdated: () => () => {},
      onActivated: () => () => {},
      onRemoved: () => () => {},
      onDetach: () => () => {},
      pageDeps: {
        connect: async () => browser as never,
        connectTab: async () => ({}) as never,
        timeoutMs: 10_000,
        settleTimings: FAST_TIMINGS,
      },
      timeoutMs: 10_000,
    });
    runtime = context as unknown as BrowserRuntime;
    const attached = await handleBrowserRuntimeMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }, runtime);
    expect(attached).toEqual({ ok: true, tabId: TAB_ID });
  }, 30_000);

  afterAll(async () => {
    await sleep(60);
    if (runtime) {
      const context = runtime as unknown as { cleanup?: () => Promise<unknown> };
      try {
        await context.cleanup?.();
      } catch {
        // Teardown racing a closing transport is noise, not a test failure.
      }
    }
    if (browser?.connected) {
      await browser.close();
    }
    server?.stop(true);
    if (teardownNet) {
      removeTeardownNet(teardownNet);
      teardownNet = null;
    }
  });

  async function freshPage(): Promise<void> {
    await rawPage!.goto(base, { waitUntil: "load" });
    await rawPage!.evaluate((clean) => history.replaceState(null, "", clean), base);
    await sleep(30);
  }

  function call(name: string, arg?: number): Promise<void> {
    return rawPage!.evaluate(
      ({ fixtureName, value }) => {
        const fn = (window as unknown as Record<string, (a?: number) => void>)[fixtureName];
        fn?.(value);
      },
      { fixtureName: name, value: arg },
    );
  }

  async function assertNoLeaks(name: string): Promise<void> {
    const observerLive = await rawPage!.evaluate(
      () => (window as Record<string, { active?: boolean }>).__astraDomWatch?.active ?? false,
    );
    expect(observerLive, `${name}: DOM observer left installed`).toBe(false);
    const detachedCount = (rawPage as unknown as { listenerCount: (event: string) => number }).listenerCount(
      "framedetached",
    );
    expect(detachedCount, `${name}: leaked framedetached listener`).toBe(0);
  }

  test(
    "cancelling a dispatching scroll resolves with action_cancelled and frees watchers",
    async () => {
      await freshPage();
      const observed = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);
      expect(observed.ok).toBe(true);
      if (!observed.ok || !observed.state) {
        throw new Error(JSON.stringify(observed));
      }
      const ref = observed.state.refs.find((candidate) => candidate.name === "Box anchor");
      if (!ref) {
        throw new Error("no Box anchor ref");
      }

      // The scroll lock keeps the container barrier pending for its whole
      // budget, so the cancel lands mid-dispatch deterministically.
      await call("__lockScrollTo", 0);
      const scheduled = runtime.scheduleAction!({
        request: {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_scroll",
          input: { mode: { mode: "bottom" }, target: { tabId: TAB_ID, snapshotId: observed.state.snapshotId, ref: ref.ref } },
          actionId: null,
          wait: { timeoutMs: 8_000 },
        },
        tabId: TAB_ID,
      });
      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) {
        throw new Error(JSON.stringify(scheduled));
      }

      await sleep(150);
      const cancelReply = runtime.cancelAction!(scheduled.actionId);
      expect(cancelReply).toMatchObject({ ok: true, cancelled: true, dispatchStarted: true });

      try {
        const settled = await scheduled.settled;
        expect(settled.ok).toBe(false);
        if (!settled.ok) {
          expect(settled.error.code).toBe("action_cancelled");
          expect(settled.error.message).toContain("during dispatch");
        }
        await sleep(50);
        await assertNoLeaks("cancel");
      } finally {
        await call("__releaseScrollLock");
      }
    },
    25_000,
  );

  test(
    "the wait envelope threads through to a real scrolled document with evidence",
    async () => {
      await freshPage();
      const observeResult = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);
      expect(observeResult.ok).toBe(true);
      if (!observeResult.ok || !observeResult.state) {
        throw new Error(JSON.stringify(observeResult));
      }
      const ref = observeResult.state.refs.find((candidate) => candidate.name === "Box anchor");
      if (!ref) {
        throw new Error("no Box anchor ref");
      }

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_scroll",
          input: { mode: { mode: "bottom" }, target: { tabId: TAB_ID, snapshotId: observeResult.state.snapshotId, ref: ref.ref } },
          wait: { timeoutMs: 3_000 },
        },
        runtime,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as
          | { kind?: string; measured?: { stability?: { status?: string; reason?: string } }; x?: number; y?: number }
          | undefined;
        expect(data?.measured?.stability?.status).toBe("stable");
        expect(typeof data?.y).toBe("number");
        const envelope = JSON.parse(JSON.stringify(result));
        expect(envelope.signals.network.status).toBe("quiet");
      }
      await assertNoLeaks("envelope");
    },
    25_000,
  );
});

function settleCtx(timeoutMs: number): { signal: AbortSignal; timeoutMs: number; expectation: null } {
  return { signal: new AbortController().signal, timeoutMs, expectation: null };
}
