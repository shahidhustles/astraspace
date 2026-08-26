import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer-core";
import { BrowserContext } from "../src/browser/context";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  handleBrowserRuntimeMessage,
  OBSERVE_SELECTED_TAB_MESSAGE,
  type BrowserRuntime,
} from "../src/browser/runtime";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import type { BrowserState, GroundedTarget } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const FRAME_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-observation.html");
const CHILD_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-child.html");
const GRANDCHILD_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-grandchild.html");

const TAB_ID = 3;
const NEW_TAB_ID = 8;

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

function requireChromePath(): string {
  if (chromePath === null) {
    throw new Error(
      "Chrome is required for browser action catalog integration tests. Set PUPPETEER_EXECUTABLE_PATH.",
    );
  }
  return chromePath;
}

describe("browser action catalog through the runtime boundary", () => {
  let browser: Browser;
  let page: Page;
  let serverA: ReturnType<typeof Bun.serve>;
  let serverB: ReturnType<typeof Bun.serve>;
  let fixtureUrl: string;
  let runtime: BrowserRuntime;

  beforeAll(async () => {
    const executablePath = requireChromePath();
    const childHtml = await Bun.file(CHILD_FIXTURE_PATH).text();
    const grandchildHtml = await Bun.file(GRANDCHILD_FIXTURE_PATH).text();

    serverB = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/browser-frame-child.html")) {
          return new Response(childHtml, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/browser-frame-grandchild.html")) {
          return new Response(grandchildHtml, { headers: { "content-type": "text/html" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const crossOriginUrl = `http://localhost:${serverB.port}/browser-frame-child.html?role=cross`;

    const mainHtml = (await Bun.file(FRAME_FIXTURE_PATH).text()).replace(
      "{{CROSS_ORIGIN_URL}}",
      crossOriginUrl,
    );
    serverA = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/browser-frame-observation.html")) {
          return new Response(mainHtml, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/browser-frame-child.html")) {
          return new Response(childHtml, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/browser-frame-grandchild.html")) {
          return new Response(grandchildHtml, { headers: { "content-type": "text/html" } });
        }
        return new Response("not found", { status: 404 });
      },
    });
    fixtureUrl = `http://127.0.0.1:${serverA.port}/browser-frame-observation.html`;

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--site-per-process"],
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
      },
    });
    [page] = await browser.pages();
    await page.goto(fixtureUrl, { waitUntil: "networkidle0" });

    const context = new BrowserContext({
      queryActiveTab: async () => [{ id: TAB_ID, url: fixtureUrl, title: "Fixture" }],
      queryTabs: async () => [],
      createTab: async (url) => ({ id: NEW_TAB_ID, url, title: "Opened" }),
      updateTab: async (tabId) => ({ id: tabId, url: fixtureUrl, title: "Fixture" }),
      removeTab: async () => {},
      onUpdated: () => () => {},
      onActivated: (listener) => {
        listener({ tabId: TAB_ID } as chrome.tabs.OnActivatedInfo);
        return () => {};
      },
      onRemoved: () => () => {},
      onDetach: () => () => {},
      pageDeps: {
        connect: async () => browser,
        connectTab: async () => ({}) as never,
        timeoutMs: 10_000,
      },
      timeoutMs: 10_000,
    });
    runtime = context as unknown as BrowserRuntime;
    await attach();
  });

  afterAll(async () => {
    if (browser?.connected) {
      await browser?.close();
    }
    serverA?.stop(true);
    serverB?.stop(true);
  });

  async function freshPage(): Promise<void> {
    await page.goto(fixtureUrl, { waitUntil: "networkidle0" });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function attach(): Promise<void> {
    const result = await handleBrowserRuntimeMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }, runtime);
    expect(result).toEqual({ ok: true, tabId: TAB_ID });
  }

  async function observe(): Promise<BrowserState> {
    const result = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("observation failed");
    return result.state;
  }

  function refByName(state: BrowserState, name: string): BrowserState["refs"][number] {
    const ref = state.refs.find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`no observed ref named ${name}`);
    }
    return ref;
  }

  function targetFor(state: BrowserState, ref: BrowserState["refs"][number]): GroundedTarget {
    return { tabId: TAB_ID, snapshotId: state.snapshotId, ref: ref.ref };
  }

  function frameByUrl(urlPart: string): Frame {
    const frame = page.frames().find((candidate) => candidate.url().includes(urlPart));
    if (!frame) {
      throw new Error(`no frame with url containing ${urlPart}`);
    }
    return frame;
  }

  function jsonSafe(result: unknown): void {
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  }

  async function selectStateByName(name: string): Promise<{
    state: BrowserState;
    target: GroundedTarget;
    options: Array<{ index: number; label: string; value: string; disabled: boolean; selected: boolean }>;
  }> {
    const state = await observe();
    const target = targetFor(state, refByName(state, name));
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: target },
      runtime,
    );
    if (!result.ok || result.action !== "browser_get_select_options") {
      throw new Error(`expected get_select_options success, got ${JSON.stringify(result)}`);
    }
    if (result.data.kind !== "get_select_options") {
      throw new Error("expected get_select_options data");
    }
    return { state, target, options: result.data.options };
  }

  test(
    "observes the fixture through the runtime boundary",
    async () => {
      await freshPage();
      const state = await observe();
      expect(state.tabId).toBe(TAB_ID);
      expect(state.url).toBe(fixtureUrl);
      expect(refByName(state, "Main select").ref).toBeGreaterThan(0);
      jsonSafe(state);
    },
    30_000,
  );

  test(
    "get_select_options returns ordered options for main, iframe, and shadow selects",
    async () => {
      await freshPage();
      const main = await selectStateByName("Main select");
      expect(main.options).toEqual([
        { index: 0, label: "Alpha", value: "alpha", disabled: false, selected: true },
        { index: 1, label: "Beta", value: "beta", disabled: false, selected: false },
        { index: 2, label: "Gamma", value: "gamma", disabled: true, selected: false },
        { index: 3, label: "Duplicate", value: "duplicate", disabled: false, selected: false },
        { index: 4, label: "Duplicate", value: "duplicate", disabled: false, selected: false },
      ]);

      const same = await selectStateByName("Child select");
      expect(same.options.map((option) => option.value)).toEqual(["child-one", "child-two", "child-disabled"]);
      expect(same.options[0]).toMatchObject({ selected: true });
      expect(same.options[2]).toMatchObject({ disabled: true });

      const cross = await selectStateByName("Cross-origin select");
      expect(cross.options.map((option) => option.value)).toEqual(["child-one", "child-two", "child-disabled"]);

      const shadow = await selectStateByName("Shadow select");
      expect(shadow.options.map((option) => option.value)).toEqual(["shadow-one", "shadow-two"]);
      expect(shadow.options[0]).toMatchObject({ selected: true });
    },
    30_000,
  );

  test(
    "inspection leaves the snapshot executable",
    async () => {
      await freshPage();
      const state = await observe();
      const target = targetFor(state, refByName(state, "Main select"));
      const first = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: target },
        runtime,
      );
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.snapshotInvalidated).toBe(false);
      }
      const second = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: target },
        runtime,
      );
      expect(second.ok).toBe(true);
      jsonSafe(second);
    },
    30_000,
  );

  test(
    "select_option changes the control and emits observable input and change events",
    async () => {
      await freshPage();
      const { target, options } = await selectStateByName("Main select");
      const beta = options.find((option) => option.value === "beta");
      if (!beta) {
        throw new Error("missing beta option");
      }

      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target, index: beta.index, label: beta.label, value: beta.value },
        },
        runtime,
      );

      expect(result).toMatchObject({
        ok: true,
        action: "browser_select_option",
        tabId: TAB_ID,
        snapshotInvalidated: true,
        data: { kind: "select_option", selectedIndex: beta.index },
      });
      jsonSafe(result);

      const value = await page.evaluate(() => (document.getElementById("main-select") as HTMLSelectElement).value);
      expect(value).toBe("beta");
      const log = await page.evaluate(() => document.getElementById("select-event-log")?.textContent ?? "");
      expect(log).toContain("input:beta");
      expect(log).toContain("change:beta");
    },
    30_000,
  );

  test(
    "select_option works in an iframe and an open shadow root",
    async () => {
      await freshPage();

      const child = await selectStateByName("Child select");
      const childTwo = child.options.find((option) => option.value === "child-two");
      if (!childTwo) {
        throw new Error("missing child-two option");
      }
      const childResult = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: child.target, index: childTwo.index, label: childTwo.label, value: childTwo.value },
        },
        runtime,
      );
      expect(childResult.ok).toBe(true);
      const iframeValue = await frameByUrl("role=same").evaluate(
        () => (document.getElementById("child-select") as HTMLSelectElement).value,
      );
      expect(iframeValue).toBe("child-two");

      const shadow = await selectStateByName("Shadow select");
      const shadowTwo = shadow.options.find((option) => option.value === "shadow-two");
      if (!shadowTwo) {
        throw new Error("missing shadow-two option");
      }
      const shadowResult = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: shadow.target, index: shadowTwo.index, label: shadowTwo.label, value: shadowTwo.value },
        },
        runtime,
      );
      expect(shadowResult.ok).toBe(true);
      const shadowValue = await page.evaluate(() => {
        const host = document.getElementById("shadow-host");
        const select = host?.shadowRoot?.querySelector("select");
        return select ? (select as HTMLSelectElement).value : null;
      });
      expect(shadowValue).toBe("shadow-two");
    },
    30_000,
  );

  test(
    "wrong-kind, missing, disabled, and ambiguous choices fail without changing the control",
    async () => {
      await freshPage();

      const main = await selectStateByName("Main select");
      const buttonTarget = targetFor(main.state, refByName(main.state, "Main action"));
      const notNative = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: buttonTarget },
        runtime,
      );
      expect(notNative.ok).toBe(false);
      if (!notNative.ok) {
        expect(notNative.error).toMatchObject({ code: "not_native_select" });
      }

      const gamma = main.options.find((option) => option.value === "gamma");
      if (!gamma) {
        throw new Error("missing gamma option");
      }
      const disabled = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: main.target, index: gamma.index, label: gamma.label, value: gamma.value },
        },
        runtime,
      );
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) {
        expect(disabled.error).toMatchObject({ code: "option_disabled" });
      }
      let value = await page.evaluate(() => (document.getElementById("main-select") as HTMLSelectElement).value);
      expect(value).toBe("alpha");

      const duplicate = main.options.find((option) => option.value === "duplicate");
      if (!duplicate) {
        throw new Error("missing duplicate option");
      }
      const ambiguous = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: main.target, index: duplicate.index, label: duplicate.label, value: duplicate.value },
        },
        runtime,
      );
      expect(ambiguous.ok).toBe(false);
      if (!ambiguous.ok) {
        expect(ambiguous.error).toMatchObject({ code: "ambiguous_option" });
      }
      value = await page.evaluate(() => (document.getElementById("main-select") as HTMLSelectElement).value);
      expect(value).toBe("alpha");

      await page.evaluate(() => (window as unknown as { __rerenderSelect: () => void }).__rerenderSelect());
      const stale = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: main.target, index: 1, label: "Beta", value: "beta" },
        },
        runtime,
      );
      expect(stale.ok).toBe(false);
      value = await page.evaluate(() => (document.getElementById("main-select") as HTMLSelectElement).value);
      expect(value).toBe("alpha");

      const freshState = await observe();
      const freshTarget = targetFor(freshState, refByName(freshState, "Main select"));
      const missing = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: freshTarget, index: 99, label: "Missing", value: "missing" },
        },
        runtime,
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error).toMatchObject({ code: "option_not_found" });
      }
      value = await page.evaluate(() => (document.getElementById("main-select") as HTMLSelectElement).value);
      expect(value).toBe("alpha");
    },
    30_000,
  );

  test(
    "selection invalidates the snapshot so a later action reports stale_ref",
    async () => {
      await freshPage();
      const { target, options } = await selectStateByName("Main select");
      const beta = options.find((option) => option.value === "beta");
      if (!beta) {
        throw new Error("missing beta option");
      }
      const selected = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target, index: beta.index, label: beta.label, value: beta.value },
        },
        runtime,
      );
      expect(selected.ok).toBe(true);

      const stale = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: target },
        runtime,
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) {
        expect(stale.error).toMatchObject({ code: "stale_ref" });
      }
    },
    30_000,
  );

  test(
    "every remaining page and element family runs through the runtime boundary",
    async () => {
      await freshPage();

      let state = await observe();
      const countTarget = targetFor(state, refByName(state, "Count action"));
      const click = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: countTarget },
        runtime,
      );
      expect(click.ok).toBe(true);
      const countText = await page.evaluate(() => document.getElementById("count-button")?.textContent ?? "");
      expect(countText).toBe("Count action 1");

      state = await observe();
      const inputTarget = targetFor(state, refByName(state, "Text input"));
      const typed = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input: { target: inputTarget, text: "more" } },
        runtime,
      );
      expect(typed.ok).toBe(true);
      const typedValue = await page.evaluate(() => (document.getElementById("text-input") as HTMLInputElement).value);
      expect(typedValue).toContain("more");

      state = await observe();
      const clearTarget = targetFor(state, refByName(state, "Text input"));
      const cleared = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: clearTarget },
        runtime,
      );
      expect(cleared.ok).toBe(true);
      const clearedValue = await page.evaluate(() => (document.getElementById("text-input") as HTMLInputElement).value);
      expect(clearedValue).toBe("");

      state = await observe();
      const eventTarget = targetFor(state, refByName(state, "Event input"));
      const pressed = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_keypress",
          input: { key: "a", modifiers: { alt: false, control: false, meta: false, shift: false }, target: eventTarget },
        },
        runtime,
      );
      expect(pressed.ok).toBe(true);
      const keyValue = await page.evaluate(() => (document.getElementById("event-input") as HTMLInputElement).value);
      expect(keyValue).toBe("a");

      const scrolled = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: { mode: { mode: "page_down" } } },
        runtime,
      );
      expect(scrolled.ok).toBe(true);
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(600);

      const textScroll = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input: { text: "Scroll marker text" } },
        runtime,
      );
      expect(textScroll.ok).toBe(true);

      const navigated = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: `${fixtureUrl}?nav=1` } },
        runtime,
      );
      expect(navigated.ok).toBe(true);
      expect(page.url()).toContain("nav=1");

      const backed = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_back", input: {} },
        runtime,
      );
      expect(backed.ok).toBe(true);

      const refreshed = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_refresh", input: {} },
        runtime,
      );
      expect(refreshed.ok).toBe(true);
    },
    30_000,
  );

  test(
    "tab lifecycle actions run through the runtime boundary with JSON-safe results",
    async () => {
      await freshPage();

      const opened = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: fixtureUrl } },
        runtime,
      );
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.tabId).toBe(NEW_TAB_ID);
        expect(opened.data).toMatchObject({ kind: "open_tab" });
      }
      jsonSafe(opened);

      const switched = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_switch_tab", input: { tabId: TAB_ID } },
        runtime,
      );
      expect(switched.ok).toBe(true);
      if (switched.ok) {
        expect(switched.tabId).toBe(TAB_ID);
        expect(switched.data).toMatchObject({ kind: "switch_tab" });
      }
      jsonSafe(switched);

      const closed = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_close_tab", input: { tabId: TAB_ID } },
        runtime,
      );
      expect(closed.ok).toBe(true);
      if (closed.ok) {
        expect(closed.tabId).toBe(TAB_ID);
        expect(closed.data).toMatchObject({ kind: "close_tab" });
      }
      jsonSafe(closed);
    },
    30_000,
  );
});
