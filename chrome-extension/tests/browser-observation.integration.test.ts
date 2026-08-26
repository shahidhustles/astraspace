import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Frame, type Page, type Target } from "puppeteer-core";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { BrowserState, GroundedTarget } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const DEVICE_SCALE_FACTOR = 2;

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-observation.html");
const FRAME_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-observation.html");
const CHILD_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-child.html");
const GRANDCHILD_FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-frame-grandchild.html");

const TOP_REF_IDS = ["email", "password", "submit", "nested-link"];
const BOTTOM_REF_IDS = ["bottom-button", "bottom-link"];
const SECRET = "hunter2secret";

const OVERLAY_SELECTOR = ".astra-obs-overlay, .astra-obs-target, .astra-obs-badge";

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
      "Chrome is required for browser observation integration tests. Set PUPPETEER_EXECUTABLE_PATH.",
    );
  }
  return chromePath;
}

describe("live viewport synchronization", () => {
  let browser: Browser;
  let page: Page;
  let server: ReturnType<typeof Bun.serve>;
  let wrapper: BrowserPage;
  let fixtureUrl: string;

  beforeAll(async () => {
    const executablePath = requireChromePath();
    const html = await Bun.file(FIXTURE_PATH).text();
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    fixtureUrl = `http://127.0.0.1:${server.port}/browser-observation.html`;

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: {
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      },
    });
    [page] = await browser.pages();
    await page.goto(fixtureUrl, { waitUntil: "load" });

    const deps: PageDeps = {
      connect: async () => browser,
      connectTab: async () => ({}) as never,
      timeoutMs: 10_000,
    };
    wrapper = new BrowserPage(1, fixtureUrl, deps);
    const attach = await wrapper.attach();
    if (!attach.ok) {
      throw new Error("fixture attach failed");
    }
  });

  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function observeCollectingLabels(): Promise<{
    result: Awaited<ReturnType<BrowserPage["observe"]>>;
    labels: number[][];
  }> {
    const realScreenshot = page.screenshot.bind(page);
    const labels: number[][] = [];
    page.screenshot = async (options?: Parameters<Page["screenshot"]>[0]) => {
      labels.push(
        await page.evaluate(() =>
          [...document.querySelectorAll(".astra-obs-badge")].map((node) => Number(node.textContent)),
        ),
      );
      return realScreenshot(options);
    };
    try {
      const result = await wrapper.observe();
      return { result, labels };
    } finally {
      page.screenshot = realScreenshot;
    }
  }

  async function rectsOf(ids: string[]): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
    return page.evaluate((elementIds) =>
      elementIds.map((id) => {
        const rect = document.getElementById(id)?.getBoundingClientRect();
        return {
          x: Math.round(rect?.x ?? 0),
          y: Math.round(rect?.y ?? 0),
          width: Math.round(rect?.width ?? 0),
          height: Math.round(rect?.height ?? 0),
        };
      }),
      ids,
    );
  }

  async function overlayCount(): Promise<number> {
    return page.evaluate((selector) => document.querySelectorAll(selector).length, OVERLAY_SELECTOR);
  }

  async function overlayStylePresent(): Promise<boolean> {
    return page.evaluate(() => document.querySelector("[data-astra-observation] style") !== null);
  }

  test(
    "the first observation describes the visible viewport",
    async () => {
      const { result, labels } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      expect(state.url).toBe(fixtureUrl);
      expect(state.title).toBe("Observation fixture");
      expect(state.scroll.x).toBe(0);
      expect(state.scroll.y).toBe(0);
      expect(state.scroll.atTop).toBe(true);
      expect(state.scroll.atBottom).toBe(false);
      expect(state.scroll.maxY).toBeGreaterThan(0);

      expect(state.refs.map((ref) => ref.bounds)).toEqual(await rectsOf(TOP_REF_IDS));
      expect(state.refs.map((ref) => ref.ref)).toEqual([1, 2, 3, 4]);
      expect(state.dom).toContain("TOP VISIBLE TEXT");
      expect(state.dom).not.toContain("BOTTOM VISIBLE TEXT");
      expect(state.screenshot.data.startsWith("/9j/")).toBe(true);
      expect(state.screenshot.width).toBe(VIEWPORT_WIDTH * DEVICE_SCALE_FACTOR);
      expect(state.screenshot.height).toBe(VIEWPORT_HEIGHT * DEVICE_SCALE_FACTOR);

      expect(labels).toEqual([state.refs.map((ref) => ref.ref)]);
      expect(await overlayCount()).toBe(0);
      expect(await overlayStylePresent()).toBe(false);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
    30_000,
  );

  test(
    "scrolling produces a matching second observation",
    async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const { result, labels } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      expect(state.scroll.atTop).toBe(false);
      expect(state.scroll.atBottom).toBe(true);
      expect(state.scroll.y).toBeGreaterThan(0);

      expect(state.refs.map((ref) => ref.bounds)).toEqual(await rectsOf(BOTTOM_REF_IDS));
      expect(state.refs.map((ref) => ref.ref)).toEqual([1, 2]);
      expect(state.dom).toContain("BOTTOM VISIBLE TEXT");
      expect(state.dom).not.toContain("TOP VISIBLE TEXT");

      expect(labels).toEqual([state.refs.map((ref) => ref.ref)]);
      expect(await overlayCount()).toBe(0);
      expect(await overlayStylePresent()).toBe(false);
    },
    30_000,
  );

  test(
    "scrolling changes the screenshot while bounds and edge flags follow",
    async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const top = await observeCollectingLabels();

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const bottom = await observeCollectingLabels();

      expect(top.result.ok && bottom.result.ok).toBe(true);
      if (!top.result.ok || !bottom.result.ok) throw new Error("expected success");

      expect(top.result.state.screenshot.data).not.toBe(bottom.result.state.screenshot.data);
      expect(top.result.state.screenshot.mimeType).toBe("image/jpeg");
      expect(bottom.result.state.screenshot.mimeType).toBe("image/jpeg");
      expect(top.result.state.screenshot.width).toBe(VIEWPORT_WIDTH * DEVICE_SCALE_FACTOR);
      expect(bottom.result.state.screenshot.height).toBe(VIEWPORT_HEIGHT * DEVICE_SCALE_FACTOR);
    },
    30_000,
  );

  test(
    "password values stay out of the observation",
    async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const { result } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      const passwordRef = state.refs.find((ref) => ref.attrs.type === "password");
      expect(passwordRef).toBeDefined();
      expect(passwordRef?.attrs.value).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain(SECRET);
    },
    30_000,
  );

  test(
    "a failed screenshot leaves no artifacts and the next observation recovers",
    async () => {
      const realScreenshot = page.screenshot.bind(page);
      page.screenshot = async () => {
        throw new Error("forced screenshot failure");
      };
      try {
        const result = await wrapper.observe();
        expect(result).toEqual({
          ok: false,
          error: { code: "observation_failed", message: "Page observation failed" },
        });
      } finally {
        page.screenshot = realScreenshot;
      }

      expect(await overlayCount()).toBe(0);
      expect(await overlayStylePresent()).toBe(false);

      const again = await wrapper.observe();
      expect(again.ok).toBe(true);
      expect(await overlayCount()).toBe(0);
    },
    30_000,
  );

  test(
    "consecutive snapshots reuse numeric refs without sharing snapshot identity",
    async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const first = await observeCollectingLabels();
      expect(first.result.ok).toBe(true);
      if (!first.result.ok) throw new Error("expected success");

      const second = await observeCollectingLabels();
      expect(second.result.ok).toBe(true);
      if (!second.result.ok) throw new Error("expected success");

      const a = first.result.state;
      const b = second.result.state;

      expect(a.refs.map((ref) => ref.ref)).toEqual([1, 2, 3, 4]);
      expect(b.refs.map((ref) => ref.ref)).toEqual(a.refs.map((ref) => ref.ref));
      expect(b.dom).toBe(a.dom);
      expect(b.screenshot.data).toBe(a.screenshot.data);
      expect(first.labels).toEqual([a.refs.map((ref) => ref.ref)]);
      expect(second.labels).toEqual([b.refs.map((ref) => ref.ref)]);

      expect(b.snapshotId).not.toBe(a.snapshotId);
      expect(b.snapshotVersion).toBe(a.snapshotVersion + 1);
      expect(a.documentEpoch).toBe(0);
      expect(a.navigationEpoch).toBe(0);
      expect(b.documentEpoch).toBe(a.documentEpoch);
      expect(b.navigationEpoch).toBe(a.navigationEpoch);

      expect(JSON.parse(JSON.stringify(first.result))).toEqual(first.result);
      expect(JSON.parse(JSON.stringify(second.result))).toEqual(second.result);
      expect(await overlayCount()).toBe(0);
    },
    30_000,
  );
});

describe("frame-aware observation in Chrome", () => {
  const tabId = 2;
  let browser: Browser;
  let page: Page;
  let serverA: ReturnType<typeof Bun.serve>;
  let serverB: ReturnType<typeof Bun.serve>;
  let wrapper: BrowserPage;
  let fixtureUrl: string;
  let crossOriginUrl: string;

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
    crossOriginUrl = `http://localhost:${serverB.port}/browser-frame-child.html?role=cross`;

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
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      },
    });
    [page] = await browser.pages();
    await freshPage();

    const deps: PageDeps = {
      connect: async () => browser,
      connectTab: async () => ({}) as never,
      timeoutMs: 10_000,
    };
    wrapper = new BrowserPage(tabId, fixtureUrl, deps);
    const attach = await wrapper.attach();
    if (!attach.ok) {
      throw new Error("fixture attach failed");
    }
  });

  afterAll(async () => {
    await browser?.close();
    serverA?.stop(true);
    serverB?.stop(true);
  });

  async function freshPage(): Promise<void> {
    await page.goto(fixtureUrl, { waitUntil: "networkidle0" });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function frameByUrl(urlPart: string): Promise<Frame> {
    const frame = page.frames().find((candidate) => candidate.url().includes(urlPart));
    if (!frame) {
      throw new Error(`no frame with url containing ${urlPart}`);
    }
    return frame;
  }

  async function waitForFrameVersion(urlPart: string, expected: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const frame = page.frames().find((candidate) => candidate.url().includes(urlPart));
      if (frame) {
        const version = await frame
          .evaluate(() => document.body?.dataset.version ?? "")
          .catch(() => "");
        if (version === expected) {
          return;
        }
      }
      await sleep(50);
    }
    throw new Error(`frame ${urlPart} never reached version ${expected}`);
  }

  async function waitForFrameGone(urlPart: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!page.frames().some((frame) => frame.url().includes(urlPart))) {
        return;
      }
      await sleep(50);
    }
    throw new Error(`frame ${urlPart} never detached`);
  }

  async function badgesAcrossFrames(): Promise<number[]> {
    const out: number[] = [];
    const visit = async (frame: Frame): Promise<void> => {
      const local = await frame.evaluate(() =>
        [...document.querySelectorAll(".astra-obs-badge")].map((node) => Number(node.textContent)),
      );
      out.push(...local);
      for (const child of frame.childFrames()) {
        await visit(child);
      }
    };
    await visit(page.mainFrame());
    return out;
  }

  async function observeCollectingLabels(): Promise<{
    result: Awaited<ReturnType<BrowserPage["observe"]>>;
    labels: number[][];
  }> {
    const realScreenshot = page.screenshot.bind(page);
    const labels: number[][] = [];
    page.screenshot = async (options?: Parameters<Page["screenshot"]>[0]) => {
      labels.push(await badgesAcrossFrames());
      return realScreenshot(options);
    };
    try {
      const result = await wrapper.observe();
      return { result, labels };
    } finally {
      page.screenshot = realScreenshot;
    }
  }

  function refByName(state: BrowserState, name: string): BrowserState["refs"][number] {
    const ref = state.refs.find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`no observed ref named ${name}`);
    }
    return ref;
  }

  function targetFor(state: BrowserState, ref: BrowserState["refs"][number]): GroundedTarget {
    return { tabId, snapshotId: state.snapshotId, ref: ref.ref };
  }

  async function elementRectInFrame(
    urlPart: string,
    elementId: string,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const frame = await frameByUrl(urlPart);
    return frame.evaluate((id) => {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      return {
        x: Math.round(rect?.x ?? 0),
        y: Math.round(rect?.y ?? 0),
        width: Math.round(rect?.width ?? 0),
        height: Math.round(rect?.height ?? 0),
      };
    }, elementId);
  }

  async function frameElementRect(elementId: string): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> {
    return page.evaluate((id) => {
      const rect = document.getElementById(id)?.getBoundingClientRect();
      return {
        x: Math.round(rect?.x ?? 0),
        y: Math.round(rect?.y ?? 0),
        width: Math.round(rect?.width ?? 0),
        height: Math.round(rect?.height ?? 0),
      };
    }, elementId);
  }

  test(
    "one observation returns unique refs and aligned labels for every frame and shadow root",
    async () => {
      await freshPage();
      const { result, labels } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      const refs = state.refs.map((ref) => ref.ref);
      expect(new Set(refs).size).toBe(refs.length);

      expect(refByName(state, "Main action")).toBeDefined();
      expect(refByName(state, "Same-origin action")).toBeDefined();
      expect(refByName(state, "Cross-origin action")).toBeDefined();
      expect(refByName(state, "Grandchild action")).toBeDefined();
      expect(refByName(state, "Shadow action")).toBeDefined();
      expect(refByName(state, "Nested shadow action")).toBeDefined();
      expect(refByName(state, "Rerender action")).toBeDefined();

      expect(state.dom).toContain("<frame>");
      expect(state.dom).toContain("<#shadow-root>");
      expect(state.dom).not.toContain("Closed shadow action");
      expect(state.refs.some((ref) => ref.name === "Closed shadow action")).toBe(false);

      expect(labels).toEqual([refs]);
      expect(await badgesAcrossFrames()).toEqual([]);

      const mainExpected = await frameElementRect("main-action");
      expect(refByName(state, "Main action").bounds).toEqual(mainExpected);

      const crossOwner = await frameElementRect("cross-origin-frame");
      const crossButton = await elementRectInFrame("role=cross", "child-action");
      expect(refByName(state, "Cross-origin action").bounds).toEqual({
        x: crossOwner.x + crossButton.x,
        y: crossOwner.y + crossButton.y,
        width: crossButton.width,
        height: crossButton.height,
      });

      const sameOwner = await frameElementRect("same-origin-frame");
      const grandOwner = await elementRectInFrame("role=same", "grandchild-frame");
      const grandButton = await elementRectInFrame("browser-frame-grandchild", "grandchild-action");
      expect(refByName(state, "Grandchild action").bounds).toEqual({
        x: sameOwner.x + grandOwner.x + grandButton.x,
        y: sameOwner.y + grandOwner.y + grandButton.y,
        width: grandButton.width,
        height: grandButton.height,
      });

      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
    30_000,
  );

  test(
    "navigating one child frame stales only its own lineage and recovers after a new observation",
    async () => {
      await freshPage();
      const { result } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      const mainRef = refByName(state, "Main action");
      const sameRef = refByName(state, "Same-origin action");
      const grandRef = refByName(state, "Grandchild action");
      const crossRef = refByName(state, "Cross-origin action");

      await page.evaluate(() => {
        const element = document.getElementById("same-origin-frame") as HTMLIFrameElement;
        element.src = "browser-frame-child.html?role=same&v=2";
      });
      await waitForFrameVersion("role=same", "2");
      await sleep(200);

      const mainResult = await wrapper.resolveTarget(targetFor(state, mainRef));
      expect(mainResult.ok).toBe(true);
      if (mainResult.ok) {
        const text = await mainResult.element.evaluate((element) => element.textContent);
        expect(text).toBe("Main action");
      }

      const crossResult = await wrapper.resolveTarget(targetFor(state, crossRef));
      expect(crossResult.ok).toBe(true);

      const sameResult = await wrapper.resolveTarget(targetFor(state, sameRef));
      expect(sameResult.ok).toBe(false);
      if (!sameResult.ok) {
        expect(sameResult.code).toBe("stale_ref");
      }

      const grandResult = await wrapper.resolveTarget(targetFor(state, grandRef));
      expect(grandResult.ok).toBe(false);
      if (!grandResult.ok) {
        expect(grandResult.code).toBe("stale_ref");
      }

      const again = await observeCollectingLabels();
      expect(again.result.ok).toBe(true);
      if (!again.result.ok) throw new Error("expected success");
      const recovered = refByName(again.result.state as BrowserState, "Same-origin action");
      const recoveredResult = await wrapper.resolveTarget(
        targetFor(again.result.state as BrowserState, recovered),
      );
      expect(recoveredResult.ok).toBe(true);
    },
    30_000,
  );

  test(
    "detaching a sibling frame stales its own controls while main and other lineages stay eligible",
    async () => {
      await freshPage();
      const { result } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;

      const mainRef = refByName(state, "Main action");
      const sameRef = refByName(state, "Same-origin action");
      const crossRef = refByName(state, "Cross-origin action");

      await page.evaluate(() => {
        document.getElementById("cross-origin-frame")?.remove();
      });
      await waitForFrameGone("role=cross");
      await sleep(200);

      const mainResult = await wrapper.resolveTarget(targetFor(state, mainRef));
      expect(mainResult.ok).toBe(true);

      const sameResult = await wrapper.resolveTarget(targetFor(state, sameRef));
      expect(sameResult.ok).toBe(true);

      const crossResult = await wrapper.resolveTarget(targetFor(state, crossRef));
      expect(crossResult.ok).toBe(false);
      if (!crossResult.ok) {
        expect(crossResult.code).toBe("stale_ref");
      }

      const again = await observeCollectingLabels();
      expect(again.result.ok).toBe(true);
      if (!again.result.ok) throw new Error("expected success");
      const next = again.result.state as BrowserState;
      expect(next.dom).not.toContain("Cross-origin action");
      expect(next.refs.some((ref) => ref.name === "Cross-origin action")).toBe(false);
    },
    30_000,
  );

  test(
    "a rerender keeps verified fallback while a different or ambiguous replacement returns no handle",
    async () => {
      await freshPage();
      const { result } = await observeCollectingLabels();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const state = result.state as BrowserState;
      const rerenderRef = refByName(state, "Rerender action");
      const target = targetFor(state, rerenderRef);
      const shadowRef = refByName(state, "Shadow action");
      const shadowTarget = targetFor(state, shadowRef);

      await page.evaluate(() => window.__rerender("same"));
      await sleep(200);
      const recovered = await wrapper.resolveTarget(target);
      expect(recovered.ok).toBe(true);
      if (recovered.ok) {
        const text = await recovered.element.evaluate((element) => element.textContent);
        expect(text).toBe("Rerender action");
      }

      await page.evaluate(() => window.__rerender("different"));
      await sleep(200);
      const different = await wrapper.resolveTarget(target);
      expect(different.ok).toBe(false);
      if (!different.ok) {
        expect(different.code).toBe("target_not_found");
      }

      await page.evaluate(() => window.__rerender("duplicate"));
      await sleep(200);
      const duplicate = await wrapper.resolveTarget(target);
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) {
        expect(duplicate.code).toBe("ambiguous_ref");
      }

      await page.evaluate(() => window.__rerenderShadow("same"));
      await sleep(200);
      const movedShadow = await wrapper.resolveTarget(shadowTarget);
      expect(movedShadow.ok).toBe(true);
      if (movedShadow.ok) {
        const id = await movedShadow.element.evaluate((element) => element.id);
        expect(id).toBe("moved-shadow-action");
      }

      await page.evaluate(() => window.__rerenderShadow("duplicate"));
      await sleep(200);
      const duplicateShadow = await wrapper.resolveTarget(shadowTarget);
      expect(duplicateShadow.ok).toBe(false);
      if (!duplicateShadow.ok) {
        expect(duplicateShadow.code).toBe("ambiguous_ref");
      }
    },
    30_000,
  );
});

describe("grounded clicking in Chrome", () => {
  const tabId = 3;
  let browser: Browser;
  let page: Page;
  let serverA: ReturnType<typeof Bun.serve>;
  let serverB: ReturnType<typeof Bun.serve>;
  let wrapper: BrowserPage;
  let fixtureUrl: string;
  let crossOriginUrl: string;
  let observedTabIds: number[];

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
    crossOriginUrl = `http://localhost:${serverB.port}/browser-frame-child.html?role=cross`;

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
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
      },
    });
    [page] = await browser.pages();
    await page.goto(fixtureUrl, { waitUntil: "networkidle0" });

    observedTabIds = [];
    browser.on("targetcreated", (target: Target) => {
      if (target?.targetId) {
        observedTabIds.push(Number(target.targetId.split(":").at(-1)));
      } else {
        observedTabIds.push(observedTabIds.length);
      }
    });
    const deps: PageDeps = {
      connect: async () => browser,
      connectTab: async () => ({}) as never,
      timeoutMs: 10_000,
    };
    wrapper = new BrowserPage(tabId, fixtureUrl, deps);
    const attach = await wrapper.attach();
    if (!attach.ok) {
      throw new Error("fixture attach failed");
    }
  });

  afterAll(async () => {
    await browser?.close();
    serverA?.stop(true);
    serverB?.stop(true);
  });

  async function observeState(): Promise<BrowserState> {
    const result = await wrapper.observe();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    return result.state as BrowserState;
  }

  async function freshPage(): Promise<void> {
    await page.goto(fixtureUrl, { waitUntil: "networkidle0" });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function refByName(state: BrowserState, name: string): BrowserState["refs"][number] {
    const ref = state.refs.find((candidate) => candidate.name === name);
    if (!ref) {
      throw new Error(`no observed ref named ${name}`);
    }
    return ref;
  }

  function targetFor(state: BrowserState, ref: BrowserState["refs"][number]): GroundedTarget {
    return { tabId, snapshotId: state.snapshotId, ref: ref.ref };
  }

  test(
    "clicks grounded buttons in the main document and an open shadow root",
    async () => {
      await freshPage();
      const state = await observeState();

      const mainResult = await wrapper.click(targetFor(state, refByName(state, "Count action")));
      expect(mainResult).toEqual({ ok: true, url: fixtureUrl, newTabId: null });
      const countText = await page.evaluate(
        () => document.getElementById("count-button")?.textContent,
      );
      expect(countText).toBe("Count action 1");

      const stateAfterMain = await observeState();
      const shadowResult = await wrapper.click(
        targetFor(stateAfterMain, refByName(stateAfterMain, "Shadow action")),
      );
      expect(shadowResult.ok).toBe(true);
      const shadowText = await page.evaluate(() => {
        const host = document.getElementById("shadow-host");
        const buttons = host?.shadowRoot?.querySelectorAll("button") ?? [];
        return [...buttons].map((node) => node.textContent);
      });
      expect(shadowText[0]).toBe("Shadow action 1");

      const after = await observeState();
      expect(refByName(after, "Count action 1")).toBeDefined();
      expect(refByName(after, "Shadow action 1")).toBeDefined();
      expect(JSON.parse(JSON.stringify(shadowResult))).toEqual(shadowResult);
    },
    30_000,
  );

  test(
    "clicks a grounded button inside a cross-origin iframe",
    async () => {
      await freshPage();
      const state = await observeState();
      const result = await wrapper.click(targetFor(state, refByName(state, "Cross-origin action")));
      expect(result).toEqual({ ok: true, url: fixtureUrl, newTabId: null });
    },
    30_000,
  );

  test(
    "rejects a target disabled after the observation without clicking it",
    async () => {
      await freshPage();
      const state = await observeState();
      await page.evaluate(() => {
        (document.getElementById("count-button") as HTMLButtonElement).disabled = true;
      });
      const result = await wrapper.click(targetFor(state, refByName(state, "Count action")));
      expect(result).toEqual({
        ok: false,
        error: { code: "disabled_target", message: "Element is disabled" },
      });
    },
    30_000,
  );

  test(
    "rejects a grounded file input without opening a picker",
    async () => {
      await freshPage();
      const state = await observeState();
      const fileRef = state.refs.find((ref) => ref.tag === "input" && ref.attrs.type === "file");
      expect(fileRef).toBeDefined();
      if (!fileRef) throw new Error("no file input ref");
      const result = await wrapper.click(targetFor(state, fileRef));
      expect(result).toEqual({
        ok: false,
        error: { code: "file_upload_required", message: "File upload is not supported" },
      });
    },
    30_000,
  );

  test(
    "a grounded click on a new-tab link opens a real tab",
    async () => {
      await freshPage();
      const state = await observeState();
      const result = await wrapper.click(targetFor(state, refByName(state, "New tab action")));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      const deadline = Date.now() + 5_000;
      while ((await browser.pages()).length < 2 && Date.now() < deadline) {
        await sleep(50);
      }
      expect((await browser.pages()).length).toBe(2);
      expect(observedTabIds.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
    30_000,
  );
});
