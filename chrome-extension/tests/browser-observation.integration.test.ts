import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { BrowserPage, type PageDeps } from "../src/browser/page";
import type { BrowserState } from "../src/browser/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const DEVICE_SCALE_FACTOR = 2;

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-observation.html");

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
