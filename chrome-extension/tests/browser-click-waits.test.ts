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
import { dispatchBrowserAction } from "../src/browser/actions/dispatcher";
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Dispatcher mapping: measured evidence rides the result envelope JSON-safe.
// ---------------------------------------------------------------------------

const UNIT_TAB: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};

function nullDeps(): Parameters<typeof dispatchBrowserAction>[1] {
  const throwing = (): never => {
    throw new Error("not used");
  };
  return {
    selectedTabId: 7,
    navigate: throwing,
    goBack: throwing,
    refresh: throwing,
    click: async () => ({ ok: true, url: "https://x.test/", newTabId: null }),
    type: throwing,
    clearInput: throwing,
    keypress: throwing,
    scroll: throwing,
    scrollToText: throwing,
    getSelectOptions: throwing,
    selectOption: throwing,
    openTab: throwing,
    switchTab: throwing,
    closeTab: throwing,
    listTabs: throwing,
  };
}

describe("click measurement mapping", () => {
  test("a bare success carries no measured field", async () => {
    const result = await dispatchBrowserAction(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: UNIT_TAB },
      nullDeps(),
    );
    expect(result).toEqual({
      ok: true,
      action: "browser_click",
      tabId: 7,
      url: "https://x.test/",
      snapshotInvalidated: true,
      data: { kind: "click", newTabId: null },
    });
  });

  test("measured evidence lands in data and signals ride the envelope", async () => {
    const runtime = nullDeps();
    (runtime as { click: typeof runtime.click }).click = async () => ({
      ok: true,
      url: "https://x.test/",
      newTabId: null,
      measurement: {
        outcome: "dom_update",
        layout: { status: "stable", samples: 2, maxDeltaPx: 0 },
        signals: { network: { status: "cancelled", ignoredRequests: 0 }, dom: { status: "quiet", idleMs: 60, watchedFrames: 1 } },
      },
    });
    const result = await dispatchBrowserAction(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: UNIT_TAB },
      runtime,
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).toMatchObject({
      signals: { dom: { status: "quiet" } },
      data: { kind: "click", measured: { outcome: "dom_update", layout: { status: "stable" } } },
    });
  });

  test("a failed click keeps its grounded error untouched", async () => {
    const runtime = nullDeps();
    (runtime as { click: typeof runtime.click }).click = async () => ({
      ok: false,
      error: { code: "stale_ref", message: "stale", target: UNIT_TAB },
    });
    const result = await dispatchBrowserAction(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: UNIT_TAB },
      runtime,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("stale_ref");
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime boundary against real Chrome.
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

const CHILD_HTML = `<!doctype html><html><body>
<div id="child-marker">Child ready</div>
<div id="child-removable" role="status">Frame status</div>
</body></html>`;

describe("click settlement through the runtime boundary", () => {
  const TAB_ID = 11;

  let browser: Browser | null = null;
  let rawPage: Page | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let base: string;
  let wrapper: BrowserPage;
  const createdListeners: Array<(tab: chrome.tabs.Tab) => void> = [];

  beforeAll(async () => {
    if (!chromePath) {
      throw new Error("Chrome is required. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    const html = await Bun.file(join(import.meta.dir, "fixtures", "browser-action-waits.html")).text();
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/child.html") {
          return new Response(CHILD_HTML, { headers: { "content-type": "text/html" } });
        }
        return new Response(html, {
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        });
      },
    });
    base = `http://127.0.0.1:${server.port}`;

    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 800, height: 600 },
    });
    [rawPage] = await browser.pages();
    await rawPage.goto(base, { waitUntil: "load" });

    wrapper = new BrowserPage(TAB_ID, `${base}/`, {
      connect: async () => browser as never,
      connectTab: async () => ({}) as never,
      timeoutMs: 10_000,
      settleTimings: FAST_TIMINGS,
      onCreated: (listener) => {
        createdListeners.push(listener);
        return () => {
          const index = createdListeners.indexOf(listener);
          if (index >= 0) {
            createdListeners.splice(index, 1);
          }
        };
      },
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
    server?.stop(true);
  });

  async function freshPage(): Promise<void> {
    await rawPage!.goto(base, { waitUntil: "load" });
    // Drop any leftover query/hash from an earlier scenario so each click
    // starts from a canonical URL.
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

  function call(name: string): Promise<void> {
    return rawPage!.evaluate((fixtureName) => {
      (window as unknown as Record<string, () => void>)[fixtureName]();
    }, name);
  }

  function jsonSafe(value: unknown): void {
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
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
    "a full navigation reports commits, final URL, and quiet signals",
    async () => {
      await freshPage();
      const snap = await state();
      const result = await wrapper.click(targetFor(snap, "Nav click"), {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
        expectation: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/?step=clicked`);
      expect(result.newTabId).toBeNull();
      expect(result.measurement?.outcome).toBe("navigation");
      const commits = result.measurement?.commits ?? [];
      expect(commits.length).toBeGreaterThanOrEqual(1);
      expect(commits.some((record) => record.kind === "main_commit")).toBe(true);
      expect(result.measurement?.signals?.network.status).toBe("quiet");
      expect(result.measurement?.signals?.dom.status).toBe("quiet");
      jsonSafe(result.measurement);
      await assertNoLeaks("nav");
    },
    20_000,
  );

  test(
    "a same-document route change completes on route evidence alone",
    async () => {
      await freshPage();
      const snap = await state();

      const result = await wrapper.click(targetFor(snap, "Route click"), {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
        expectation: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/#clicked`);
      expect(result.measurement?.outcome).toBe("same_document");
      const commits = result.measurement?.commits ?? [];
      expect(commits.some((record) => record.kind === "same_document")).toBe(true);
      expect(commits.every((record) => record.kind !== "main_commit")).toBe(true);
      await assertNoLeaks("route");
    },
    20_000,
  );

  test(
    "a DOM-only update settles from quiet and stable layout without commit evidence",
    async () => {
      await freshPage();
      const snap = await state();
      const startedAt = Date.now();

      const result = await wrapper.click(targetFor(snap, "Dom click"), {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
        expectation: null,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.url).toBe(`${base}/`);
      expect(result.measurement?.outcome).toBe("dom_update");
      expect(result.measurement?.commits).toBeUndefined();
      expect(result.measurement?.layout?.status).toBe("stable");
      expect(result.measurement?.signals?.network.status).toBe("quiet");
      // Completing on measured quiet plus two layout samples must beat the
      // 8 second cap by a wide margin; nothing sleeps out a fixed window.
      expect(elapsed).toBeLessThan(2_500);

      const items = await rawPage!.evaluate(() => document.querySelectorAll("#dom-list li").length);
      expect(items).toBe(1);
      await assertNoLeaks("dom");
    },
    20_000,
  );

  test(
    "an idle click still returns stability evidence within a tight budget",
    async () => {
      await freshPage();
      const snap = await state();
      const startedAt = Date.now();

      const result = await wrapper.click(targetFor(snap, "Idle click"), {
        signal: new AbortController().signal,
        timeoutMs: 8_000,
        expectation: null,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.measurement?.outcome).toBe("dom_update");
      expect(result.measurement?.layout?.status).toBe("stable");
      expect(elapsed).toBeLessThan(2_500);
      await assertNoLeaks("idle");
    },
    20_000,
  );

  test(
    "an appearance expectation satisfied in the main document proves completion",
    async () => {
      await freshPage();
      await call("__appearMain");
      const snap = await state();

      const result = await wrapper.click(targetFor(snap, "Idle click"), {
        signal: new AbortController().signal,
        timeoutMs: 6_000,
        expectation: { intent: "appear", role: "dialog", name: "Import ready" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.measurement?.expectation).toEqual({
        status: "satisfied",
        intent: "appear",
        scope: "main_document",
      });
      expect(await rawPage!.evaluate(() => document.querySelectorAll('#toast-host [role="dialog"]').length)).toBe(1);
      await assertNoLeaks("appear-main");
    },
    20_000,
  );

  test(
    "an appearance expectation satisfied inside a child frame names that scope",
    async () => {
      await freshPage();
      await call("__appearInFrame");
      const snap = await state();

      const result = await wrapper.click(targetFor(snap, "Idle click"), {
        signal: new AbortController().signal,
        timeoutMs: 6_000,
        expectation: { intent: "appear", role: "dialog", name: "Import ready" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.measurement?.expectation).toEqual({ status: "satisfied", intent: "appear", scope: "child_frame" });
      await assertNoLeaks("appear-frame");
    },
    20_000,
  );

  test(
    "zero remaining matches satisfies a disappearance expectation",
    async () => {
      await freshPage();
      await call("__disappearFromFrame");
      const snap = await state();

      const result = await wrapper.click(targetFor(snap, "Idle click"), {
        signal: new AbortController().signal,
        timeoutMs: 6_000,
        expectation: { intent: "disappear", role: "status", name: "Frame status" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      expect(result.measurement?.expectation).toEqual({ status: "satisfied", intent: "disappear" });
      const frameStatusGone = await rawPage!.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>("#expect-frame")?.contentDocument;
        return doc ? !doc.getElementById("child-removable") : false;
      });
      expect(frameStatusGone).toBe(true);
      await assertNoLeaks("disappear");
    },
    20_000,
  );

  test(
    "an ambiguous appearance stays pending until the deadline and still succeeds with evidence",
    async () => {
      await freshPage();
      await call("__appearAmbiguous");
      const snap = await state();
      const startedAt = Date.now();

      const result = await wrapper.click(targetFor(snap, "Idle click"), {
        signal: new AbortController().signal,
        timeoutMs: 900,
        expectation: { intent: "appear", role: "dialog", name: "Import ready" },
      });
      const elapsed = Date.now() - startedAt;

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(JSON.stringify(result));
      }
      const expectation = result.measurement?.expectation;
      expect(expectation?.status).toBe("ambiguous");
      if (expectation?.status !== "ambiguous") {
        throw new Error("expected ambiguous evidence");
      }
      expect(expectation.matches).toBeGreaterThanOrEqual(2);
      expect(elapsed).toBeGreaterThanOrEqual(850);
      await assertNoLeaks("ambiguous");
    },
    20_000,
  );

  test(
    "a popup registered after the click resolves is captured and the listener released",
    async () => {
      await freshPage();
      const snap = await state();
      // Between clicks no tab listener may linger from an earlier settlement.
      expect(createdListeners.length).toBe(0);

      // Fire the synthetic tab creation moments after the click call starts,
      // mirroring a target created while ElementHandle.click was resolving.
      let armedDuringClick = -1;
      const injectTimer = setTimeout(() => {
        armedDuringClick = createdListeners.length;
        for (const listener of [...createdListeners]) {
          listener({ id: 777, openerTabId: TAB_ID } as chrome.tabs.Tab);
        }
      }, 60);
      try {
        const result = await wrapper.click(targetFor(snap, "Idle click"), {
          signal: new AbortController().signal,
          timeoutMs: 4_000,
          expectation: null,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error(JSON.stringify(result));
        }
        expect(result.newTabId).toBe(777);
      } finally {
        clearTimeout(injectTimer);
      }

      // The detector was armed for this one click and released afterwards.
      expect(armedDuringClick).toBe(1);
      expect(createdListeners.length).toBe(0);
      await assertNoLeaks("popup");
    },
    20_000,
  );

  test(
    "the coordinator threads wait.expectation through the message boundary to dispatch",
    async () => {
      await freshPage();
      const context = new BrowserContext({
        queryActiveTab: async () => [{ id: TAB_ID, url: `${base}/`, title: "Waits fixture" }],
        queryTabs: async () => [],
        createTab: async (url) => ({ id: 99, url, title: "Opened" }),
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
      const runtime = context as unknown as BrowserRuntime;
      const attached = await handleBrowserRuntimeMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }, runtime);
      expect(attached).toEqual({ ok: true, tabId: TAB_ID });

      await call("__appearMain");
      const observed = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);
      expect(observed.ok).toBe(true);
      if (!observed.ok || !observed.state) {
        throw new Error(JSON.stringify(observed));
      }
      const targetRef = observed.state.refs.find((candidate) => candidate.name === "Route click");
      if (!targetRef) {
        throw new Error("no Route click ref");
      }

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_click",
          input: { tabId: TAB_ID, snapshotId: observed.state.snapshotId, ref: targetRef.ref },
          wait: { timeoutMs: 3_000, expectation: { intent: "appear", role: "dialog", name: "Import ready" } },
        },
        runtime,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as
          | { kind?: string; measured?: { outcome?: string; expectation?: { status?: string; intent?: string } } }
          | undefined;
        expect(data?.measured?.expectation?.status).toBe("satisfied");
        expect(data?.measured?.expectation?.intent).toBe("appear");

        const bad = await handleBrowserRuntimeMessage(
          {
            type: BROWSER_ACTION_MESSAGE,
            action: "browser_click",
            input: { tabId: TAB_ID, snapshotId: observed.state.snapshotId, ref: targetRef.ref },
            wait: { expectation: { intent: "later", role: "dialog", name: "x" } },
          },
          runtime,
        );
        expect(bad.ok).toBe(false);
        if (!bad.ok) {
          expect(bad.error.code).toBe("invalid_action");
        }
      }
      await assertNoLeaks("boundary");
    },
    25_000,
  );
});
