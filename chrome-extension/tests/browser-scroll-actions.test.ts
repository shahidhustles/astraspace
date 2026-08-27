import { describe, expect, test } from "bun:test";
import type { ElementHandle, Frame } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { PathStep } from "../src/browser/observation/types";
import {
  scrollGroundedTarget,
  scrollTargetY,
  scrollToVisibleText,
  type ScrollDeps,
} from "../src/browser/actions/scroll";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { dispatchBrowserAction } from "../src/browser/actions/dispatcher";
import {
  surfaceScrollSample,
  waitForScrollSettled,
  type ScrollSample,
} from "../src/browser/waits/scroll";
import { resolveSettleTimings, type ActionSettleSignals } from "../src/browser/waits/types";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return attachTabActionCoordinator({
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    click: async () => ({ ok: true, url: "https://example.com", newTabId: null }),
    type: async () => ({ ok: true, url: "https://example.com" }),
    clearInput: async () => ({ ok: true, url: "https://example.com" }),
    keypress: async () => ({ ok: true, url: "https://example.com" }),
    scroll: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    scrollToText: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  });
}

describe("browser_scroll dispatch", () => {
  test("scrolls the document through the action contract", async () => {
    let received: unknown = null;
    const runtime = fakeRuntime({
      scroll: async (input) => {
        received = input;
        return { ok: true, url: "https://example.com/final", position: { x: 0, y: 600 } };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: { mode: { mode: "page_down" } } },
      runtime,
    );

    expect(received).toEqual({ mode: { mode: "page_down" } });
    expect(result).toEqual({
      ok: true,
      action: "browser_scroll",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "scroll", x: 0, y: 600 },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("scrolls a grounded container through the action contract", async () => {
    let received: unknown = null;
    const runtime = fakeRuntime({
      scroll: async (input) => {
        received = input;
        return { ok: true, url: "https://example.com/final", position: { x: 0, y: 80 } };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_scroll",
        input: { mode: { mode: "bottom" }, target: TARGET },
      },
      runtime,
    );

    expect(received).toEqual({ mode: { mode: "bottom" }, target: TARGET });
    expect(result).toEqual({
      ok: true,
      action: "browser_scroll",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "scroll", x: 0, y: 80 },
    });
  });

  test("preserves grounded-target failures", async () => {
    const runtime = fakeRuntime({
      scroll: async () => ({ ok: false, error: { code: "stale_ref", message: "stale", target: TARGET } }),
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_scroll",
        input: { mode: { mode: "top" }, target: TARGET },
      },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_scroll",
      tabId: 7,
      error: { code: "stale_ref", message: "stale", target: TARGET },
    });
  });

  test("returns selected_tab_unavailable for a document scroll with no selected tab", async () => {
    const runtime = fakeRuntime({ selectedTabId: null });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: { mode: { mode: "top" } } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_scroll",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("returns action_failed when the scroll runtime throws", async () => {
    const runtime = fakeRuntime({
      scroll: async () => {
        throw new Error("boom");
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: { mode: { mode: "top" } } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_scroll",
      tabId: 7,
      error: { code: "action_failed", message: "Browser action failed" },
    });
  });

  test("rejects a malformed scroll request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { mode: {} },
      { mode: { mode: "unknown" } },
      { mode: { mode: "page_down", percent: 50 } },
      { mode: { mode: "percent" } },
      { mode: { mode: "percent", percent: 101 } },
      { mode: { mode: "percent", percent: -1 } },
      { mode: { mode: "percent", percent: 50.5 } },
      { mode: { mode: "top" }, target: { ...TARGET, ref: 0 } },
      { mode: { mode: "top" }, extra: true },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_scroll",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_scroll") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("browser_scroll_to_text dispatch", () => {
  test("scrolls to the default first occurrence", async () => {
    let received: { text: string; occurrence: number } | null = null;
    const runtime = fakeRuntime({
      scrollToText: async (text, occurrence) => {
        received = { text, occurrence };
        return { ok: true, url: "https://example.com/final", position: { x: 0, y: 900 } };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input: { text: "Scroll marker text" } },
      runtime,
    );

    expect(received).toEqual({ text: "Scroll marker text", occurrence: 1 });
    expect(result).toEqual({
      ok: true,
      action: "browser_scroll_to_text",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "scroll_to_text", x: 0, y: 900 },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("scrolls to a requested one-based occurrence", async () => {
    let received: { text: string; occurrence: number } | null = null;
    const runtime = fakeRuntime({
      scrollToText: async (text, occurrence) => {
        received = { text, occurrence };
        return { ok: true, url: "https://example.com/final", position: { x: 0, y: 1200 } };
      },
    });

    await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_scroll_to_text",
        input: { text: "Scroll marker text", occurrence: 3 },
      },
      runtime,
    );

    expect(received).toEqual({ text: "Scroll marker text", occurrence: 3 });
  });

  test("preserves text_not_found failures", async () => {
    const runtime = fakeRuntime({
      scrollToText: async () => ({ ok: false, error: { code: "text_not_found", message: "missing" } }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input: { text: "missing" } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_scroll_to_text",
      tabId: 7,
      error: { code: "text_not_found", message: "missing" },
    });
  });

  test("returns selected_tab_unavailable with no selected tab", async () => {
    const runtime = fakeRuntime({ selectedTabId: null });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input: { text: "Scroll marker text" } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_scroll_to_text",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("rejects a malformed scroll_to_text request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { text: "" },
      { text: 5 },
      { text: "x", occurrence: 0 },
      { text: "x", occurrence: -2 },
      { text: "x", occurrence: 1.5 },
      { text: "x", extra: true },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_scroll_to_text",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_scroll_to_text") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("scrollTargetY", () => {
  test("clamps page movement and edges to the scroll range", () => {
    expect(scrollTargetY({ mode: "page_down" }, 0, 1000, 300)).toBe(300);
    expect(scrollTargetY({ mode: "page_down" }, 900, 1000, 300)).toBe(1000);
    expect(scrollTargetY({ mode: "page_up" }, 300, 1000, 300)).toBe(0);
    expect(scrollTargetY({ mode: "page_up" }, 0, 1000, 300)).toBe(0);
    expect(scrollTargetY({ mode: "top" }, 500, 1000, 300)).toBe(0);
    expect(scrollTargetY({ mode: "bottom" }, 0, 1000, 300)).toBe(1000);
  });

  test("rounds percentages across the scroll range", () => {
    expect(scrollTargetY({ mode: "percent", percent: 0 }, 0, 1000, 300)).toBe(0);
    expect(scrollTargetY({ mode: "percent", percent: 50 }, 0, 1000, 300)).toBe(500);
    expect(scrollTargetY({ mode: "percent", percent: 100 }, 0, 1000, 300)).toBe(1000);
    expect(scrollTargetY({ mode: "percent", percent: 33 }, 0, 1000, 300)).toBe(330);
  });
});

describe("scrollGroundedTarget", () => {
  interface ContainerMetrics {
    scrollTop: number;
    maxY: number;
    clientHeight: number;
  }

  interface ElementCalls {
    measure: boolean;
    apply: boolean;
    applyY: number | null;
    dispose: boolean;
  }

  function fakeElement(
    calls: ElementCalls,
    opts: { container: ContainerMetrics | null; position?: { x: number; y: number }; applyThrows?: boolean },
  ): ElementHandle<Element> {
    return {
      evaluate: async (fn: unknown, y?: number) => {
        if (y === undefined) {
          calls.measure = true;
          return opts.container;
        }
        if (opts.applyThrows) {
          throw new Error("detached");
        }
        calls.apply = true;
        calls.applyY = y;
        return opts.position ?? { x: 0, y: 0 };
      },
      dispose: async () => {
        calls.dispose = true;
      },
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<ScrollDeps> = {}): { log: string[]; deps: ScrollDeps } {
    const log: string[] = [];
    return {
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeElement(elementCalls(), { container: null }) };
        },
        invalidate: () => log.push("invalidate"),
        currentUrl: () => "https://example.com/final",
        frame: () => null,
        ...overrides,
      },
    };
  }

  function elementCalls(): ElementCalls {
    return { measure: false, apply: false, applyY: null, dispose: false };
  }

  test("resolves, measures, invalidates, applies, and disposes in order", async () => {
    const calls = elementCalls();
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return {
        ok: true,
        element: fakeElement(calls, {
          container: { scrollTop: 0, maxY: 400, clientHeight: 100 },
          position: { x: 0, y: 400 },
        }),
      };
    };

    const result = await scrollGroundedTarget(TARGET, { mode: "bottom" }, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", position: { x: 0, y: 400 } });
    expect(log).toEqual(["resolve", "invalidate"]);
    expect(calls.measure).toBe(true);
    expect(calls.apply).toBe(true);
    expect(calls.applyY).toBe(400);
    expect(calls.dispose).toBe(true);
  });

  test("applies a percentage to the container scroll range", async () => {
    const calls = elementCalls();
    const { deps } = fakeDeps();
    deps.resolveTarget = async () => ({
      ok: true,
      element: fakeElement(calls, {
        container: { scrollTop: 10, maxY: 400, clientHeight: 100 },
        position: { x: 0, y: 200 },
      }),
    });

    const result = await scrollGroundedTarget(TARGET, { mode: "percent", percent: 50 }, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position).toEqual({ x: 0, y: 200 });
    }
    expect(calls.applyY).toBe(200);
  });

  test("returns action_failed for a non-scrollable target without invalidating", async () => {
    const calls = elementCalls();
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return {
        ok: true,
        element: fakeElement(calls, { container: null }),
      };
    };

    const result = await scrollGroundedTarget(TARGET, { mode: "top" }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Target has no scrollable ancestor" },
    });
    expect(log).toEqual(["resolve"]);
    expect(calls.apply).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("touches nothing when resolution fails", async () => {
    const calls = elementCalls();
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: false,
        code: "stale_ref",
        target: TARGET,
        reason: "stale",
      }),
    });

    const result = await scrollGroundedTarget(TARGET, { mode: "top" }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "stale_ref", message: "stale", target: TARGET },
    });
    expect(log).toEqual([]);
    expect(calls.measure).toBe(false);
    expect(calls.dispose).toBe(false);
  });

  test("disposes the handle when the apply evaluation throws", async () => {
    const calls = elementCalls();
    const { deps } = fakeDeps();
    deps.resolveTarget = async () => ({
      ok: true,
      element: fakeElement(calls, {
        container: { scrollTop: 0, maxY: 400, clientHeight: 100 },
        applyThrows: true,
      }),
    });

    const result = await scrollGroundedTarget(TARGET, { mode: "bottom" }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(calls.dispose).toBe(true);
  });
});

describe("scrollToVisibleText", () => {
  function fakeElement(
    opts: { position?: { x: number; y: number }; throws?: boolean; disposed?: () => void } = {},
  ): ElementHandle<Element> {
    return {
      evaluate: async (fn: unknown) => {
        if (opts.throws) {
          throw new Error("detached");
        }
        return opts.position ?? { x: 0, y: 900 };
      },
      dispose: async () => {
        opts.disposed?.();
      },
    } as unknown as ElementHandle<Element>;
  }

  function fakeFrame(
    opts: { paths: PathStep[][]; element: ElementHandle<Element>; childFrames?: Frame[] },
  ): Frame {
    return {
      evaluate: async (fn: unknown, _text?: string) => opts.paths,
      evaluateHandle: async (fn: unknown, _path: PathStep[]) => ({ asElement: () => opts.element }),
      childFrames: () => opts.childFrames ?? [],
    } as unknown as Frame;
  }

  function fakeDeps(frame: Frame | null, overrides: Partial<ScrollDeps> = {}): ScrollDeps {
    return {
      resolveTarget: async (): Promise<TargetResolutionResult> => ({
        ok: false,
        code: "stale_ref",
        target: TARGET,
        reason: "not used",
      }),
      invalidate: () => {},
      currentUrl: () => "https://example.com/final",
      frame: () => frame,
      ...overrides,
    };
  }

  test("scrolls to the requested occurrence and disposes the handle", async () => {
    let disposed = 0;
    const element = fakeElement({
      position: { x: 0, y: 900 },
      disposed: () => {
        disposed += 1;
      },
    });
    const frame = fakeFrame({
      paths: [
        [{ kind: "child", index: 1 }],
        [{ kind: "child", index: 2 }],
        [{ kind: "child", index: 3 }],
      ],
      element,
    });

    const result = await scrollToVisibleText("Scroll marker text", 2, fakeDeps(frame));

    expect(result).toEqual({ ok: true, url: "https://example.com/final", position: { x: 0, y: 900 } });
    expect(disposed).toBe(1);
  });

  test("searches child frames in document order", async () => {
    const childElement = fakeElement({ position: { x: 0, y: 200 } });
    const childFrame = fakeFrame({ paths: [[{ kind: "child", index: 5 }]], element: childElement });
    const mainFrame = fakeFrame({
      paths: [[{ kind: "child", index: 1 }]],
      element: fakeElement(),
      childFrames: [childFrame],
    });

    const result = await scrollToVisibleText("Scroll marker text", 2, fakeDeps(mainFrame));

    expect(result).toEqual({ ok: true, url: "https://example.com/final", position: { x: 0, y: 200 } });
  });

  test("returns text_not_found when the occurrence exceeds the visible matches", async () => {
    const frame = fakeFrame({ paths: [[{ kind: "child", index: 1 }]], element: fakeElement() });

    const result = await scrollToVisibleText("Scroll marker text", 2, fakeDeps(frame));

    expect(result).toEqual({
      ok: false,
      error: { code: "text_not_found", message: expect.stringContaining("occurrence 2") },
    });
  });

  test("returns selected_tab_unavailable without a frame", async () => {
    const result = await scrollToVisibleText("Scroll marker text", 1, fakeDeps(null));

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("disposes the handle when scrolling into view throws", async () => {
    let disposed = 0;
    const frame = fakeFrame({
      paths: [[{ kind: "child", index: 1 }]],
      element: fakeElement({
        throws: true,
        disposed: () => {
          disposed += 1;
        },
      }),
    });

    const result = await scrollToVisibleText("Scroll marker text", 1, fakeDeps(frame));

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(disposed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scroll settlement barrier
// ---------------------------------------------------------------------------

const BARRIER_TIMINGS = resolveSettleTimings({
  domQuietMs: 40,
  networkQuietMs: 50,
  pollMs: 5,
  layoutSampleSpanMs: 25,
  layoutTolerancePx: 2,
});

function makeProbe(values: Array<ScrollSample | null>): ScrollSurfaceProbe {
  const queue = [...values];
  return {
    read: async (): Promise<ScrollSample | null> => (queue.length > 1 ? queue.shift()! : queue[0]),
  };
}

describe("waitForScrollSettled", () => {
  function base(values: Array<ScrollSample | null>, extra: Record<string, unknown> = {}) {
    return {
      probe: makeProbe(values),
      targetY: 400,
      timings: BARRIER_TIMINGS,
      timeoutMs: 1_000,
      ...extra,
    };
  }

  test("two samples holding the requested position settle as stable", async () => {
    const result = await waitForScrollSettled(
      base([
        { x: 0, y: 400 },
        { x: 0, y: 400 },
      ]),
    );
    expect(result.stability).toEqual({ status: "stable", samples: 2, maxDeltaPx: 0 });
    expect(result.signals).toBeUndefined();
  });

  test("reached-but-drifting position unsettles as unstable at the budget", async () => {
    const result = await waitForScrollSettled(
      base(
        [
          { x: 0, y: 400 },
          { x: 0, y: 404 },
          { x: 0, y: 396 },
          { x: 0, y: 404 },
          { x: 0, y: 396 },
          { x: 0, y: 404 },
          { x: 0, y: 396 },
          { x: 0, y: 404 },
        ],
        { timeoutMs: 120 },
      ),
    );
    expect(result.stability.status).toBe("unsettled");
    if (result.stability.status !== "unsettled") {
      throw new Error("expected unsettled");
    }
    expect(result.stability.reason).toBe("unstable");
    expect(result.stability.maxDeltaPx).toBeGreaterThanOrEqual(4);
    expect(result.stability.targetY).toBe(400);
    expect(result.stability.lastY).not.toBeNull();
    expect(result.stability.timeoutMs).toBeLessThanOrEqual(250);
  });

  test("a vanished surface reports unreachable immediately", async () => {
    const result = await waitForScrollSettled(base([null]));
    expect(result.stability).toEqual({
      status: "unsettled",
      reason: "unreachable",
      timeoutMs: expect.any(Number),
      sampleCount: 1,
      maxDeltaPx: 0,
      targetY: 400,
      lastY: null,
    });
  });

  test("a position that never reaches the target unsettles as unreachable", async () => {
    const held = { x: 0, y: 100 };
    const result = await waitForScrollSettled(
      base([held, held, held, held, held, held, held], { timeoutMs: 110 }),
    );
    expect(result.stability.status).toBe("unsettled");
    if (result.stability.status !== "unsettled") {
      throw new Error("expected unsettled");
    }
    expect(result.stability.reason).toBe("unreachable");
    expect(result.stability.lastY).toBe(100);
  });

  test("cancellation wins over an unfinished wait", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    const moving = [
      { x: 0, y: 404 },
      { x: 0, y: 396 },
      { x: 0, y: 404 },
      { x: 0, y: 396 },
      { x: 0, y: 404 },
    ];
    const input = base(moving, { signal: controller.signal, timeoutMs: null });
    const startedAt = Date.now();
    const result = await waitForScrollSettled(input);
    expect(result.stability.status).toBe("cancelled");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("completion awaits the armed quiet reading", async () => {
    let quietDone = false;
    const result = await waitForScrollSettled({
      probe: makeProbe([
        { x: 0, y: 400 },
        { x: 0, y: 400 },
      ]),
      targetY: 400,
      timings: BARRIER_TIMINGS,
      timeoutMs: 1_000,
      waitForQuiet: async () => {
        await sleep(70);
        quietDone = true;
        return SETTLE_SIGNALS;
      },
    });
    expect(result.stability.status).toBe("stable");
    expect(quietDone).toBe(true);
    expect(result.signals).toEqual(SETTLE_SIGNALS);
  });

  test("the quiet reading starts once regardless of sampled pairs", async () => {
    let quietCalls = 0;
    const probeQueue = [
      { x: 0, y: 400 },
      { x: 0, y: 406 },
      { x: 0, y: 404 },
      { x: 0, y: 404 },
    ];
    const result = await waitForScrollSettled({
      probe: makeProbe(probeQueue),
      targetY: 404,
      timings: BARRIER_TIMINGS,
      timeoutMs: 1_000,
      waitForQuiet: async () => {
        quietCalls += 1;
        return SETTLE_SIGNALS;
      },
    });
    expect(result.stability.status).toBe("stable");
    expect(quietCalls).toBe(1);
  });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SETTLE_SIGNALS: ActionSettleSignals = {
  network: { status: "quiet", idleMs: 80, ignoredRequests: 0 },
  dom: { status: "quiet", idleMs: 60, watchedFrames: 1 },
};

// ---------------------------------------------------------------------------
// Settlement threaded through the action layer
// ---------------------------------------------------------------------------

interface ContainerMetricsLike {
  scrollTop: number;
  maxY: number;
  clientHeight: number;
}

function surfaceFakeElement(
  calls: { disposed: boolean },
  options: {
    container: ContainerMetricsLike | null;
    applyPosition: { x: number; y: number } | null;
    surface: ScrollSample;
  },
): ElementHandle<Element> {
  return {
    evaluate: async (fn: unknown, y?: unknown) => {
      if (fn === surfaceScrollSample) {
        return options.surface;
      }
      if (y === undefined) {
        return options.container;
      }
      if (!options.applyPosition) {
        throw new Error("detached");
      }
      return options.applyPosition;
    },
    dispose: async () => {
      calls.disposed = true;
    },
  } as unknown as ElementHandle<Element>;
}

describe("scroll actions run the settle barrier while the handle is retained", () => {
  test("grounded container scroll resolves once and probes after invalidation", async () => {
    const calls = { disposed: false };
    const log: string[] = [];
    let resolveCount = 0;
    const element = surfaceFakeElement(calls, {
      container: { scrollTop: 0, maxY: 400, clientHeight: 100 },
      applyPosition: { x: 0, y: 400 },
      surface: { x: 0, y: 400 },
    });
    const deps: ScrollDeps = {
      resolveTarget: async () => {
        resolveCount += 1;
        log.push("resolve");
        return { ok: true, element };
      },
      invalidate: () => log.push("invalidate"),
      currentUrl: () => "https://example.com/final",
      frame: () => null,
      settle: async ({ probe, targetY }) => {
        log.push("settle");
        expect(targetY).toBe(400);
        const sample = await probe.read();
        log.push(`probe-read:${sample ? sample.y : "gone"}`);
        return { stability: { status: "stable", samples: 2, maxDeltaPx: 0 }, signals: SETTLE_SIGNALS };
      },
    };

    const result = await scrollGroundedTarget(TARGET, { mode: "bottom" }, deps);

    expect(result.ok).toBe(true);
    if (result.ok && result.measurement) {
      expect(result.measurement.stability).toEqual({ status: "stable", samples: 2, maxDeltaPx: 0 });
      expect(result.measurement.signals).toEqual(SETTLE_SIGNALS);
    }
    expect(log).toEqual(["resolve", "invalidate", "settle", "probe-read:400"]);
    expect(resolveCount).toBe(1);
    expect(calls.disposed).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("visible-text scroll settles against its landing position", async () => {
    const calls = { disposed: false };
    const seen: string[] = [];
    const element = {
      evaluate: async (fn: unknown) => {
        const label = (fn as { name?: string }).name ?? "";
        if (label === "scrollElementIntoView") {
          return { x: 0, y: 900 };
        }
        if (fn === surfaceScrollSample) {
          return { x: 0, y: 900 };
        }
        throw new Error(`unexpected evaluation: ${label}`);
      },
      dispose: async () => {
        calls.disposed = true;
      },
    } as unknown as ElementHandle<Element>;
    const frame = {
      evaluate: async (_fn: unknown, _text?: string) => [[{ kind: "child", index: 1 }] as PathStep[]],
      evaluateHandle: async (_fn: unknown, _path?: PathStep[]) => ({ asElement: () => element }),
      childFrames: () => [],
    } as unknown as Frame;
    const deps: ScrollDeps = {
      resolveTarget: async () => ({
        ok: false,
        code: "stale_ref",
        target: TARGET,
        reason: "not used",
      }),
      invalidate: () => {},
      currentUrl: () => "https://example.com/final",
      frame: () => frame,
      settle: async ({ probe, targetY }) => {
        seen.push("settle");
        expect(targetY).toBe(900);
        const sample = await probe.read();
        expect(sample).toEqual({ x: 0, y: 900 });
        return { stability: { status: "stable", samples: 2, maxDeltaPx: 0 } };
      },
    };

    const result = await scrollToVisibleText("Scroll marker text", 1, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.position).toEqual({ x: 0, y: 900 });
      expect(result.measurement?.stability).toEqual({ status: "stable", samples: 2, maxDeltaPx: 0 });
      expect(result.measurement?.signals).toBeUndefined();
    }
    expect(seen).toEqual(["settle"]);
    expect(calls.disposed).toBe(true);
  });
});

describe("dispatcher evidence mapping for scroll results", () => {
  function evidenceRuntime(
    overrides: Partial<BrowserRuntime> = {},
  ): BrowserRuntime {
    const failing = (): never => {
      throw new Error("not used");
    };
    return attachTabActionCoordinator({
      selectedTabId: 7,
      useActiveTab: async () => ({ ok: true, tabId: 7 }),
      observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
      navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
      goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
      refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
      click: async () => ({ ok: true, url: "https://example.com/final", newTabId: null }),
      type: async () => ({ ok: true, url: "https://example.com/final" }),
      clearInput: async () => ({ ok: true, url: "https://example.com/final" }),
      keypress: async () => ({ ok: true, url: "https://example.com/final" }),
      scroll: async () => failing(),
      scrollToText: async () => failing(),
      openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
      switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
      closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
      listTabs: async () => ({ ok: true, tabs: [] }),
      ...overrides,
    });
  }

  test("browser_scroll hoists signals and folds measurement into data", async () => {
    let receivedSettle: Parameters<BrowserRuntime["scroll"]>[1] = null;
    const measurement = { stability: { status: "stable" as const, samples: 2, maxDeltaPx: 0 }, signals: SETTLE_SIGNALS };
    const runtime = evidenceRuntime({
      scroll: async (_input, settle) => {
        receivedSettle = settle ?? null;
        return { ok: true, url: "https://example.com/final", position: { x: 0, y: 600 }, measurement };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_scroll",
        input: { mode: { mode: "page_down" } },
        wait: { timeoutMs: 1_500 },
      },
      runtime,
    );

    expect(receivedSettle?.timeoutMs).toBe(1_500);
    expect(receivedSettle?.signal instanceof AbortSignal).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result).toMatchObject({
      ok: true,
      signals: { dom: { status: "quiet" } },
      data: { kind: "scroll", x: 0, y: 600, measured: { stability: { status: "stable" } } },
    });
  });

  test("browser_scroll_to_text carries the same evidence shape", async () => {
    const runtime = evidenceRuntime({
      scrollToText: async () => ({
        ok: true,
        url: "https://example.com/final",
        position: { x: 0, y: 900 },
        measurement: {
          stability: {
            status: "unsettled" as const,
            reason: "unreachable" as const,
            timeoutMs: 300,
            sampleCount: 3,
            maxDeltaPx: 12,
            targetY: 900,
            lastY: 870,
          },
        },
      }),
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_scroll_to_text",
        input: { text: "Scroll marker text", occurrence: 1 },
        wait: { timeoutMs: 800 },
      },
      runtime,
    );

    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data;
      expect(data.kind === "scroll_to_text" ? data.measured?.stability.status : null).toBe("unsettled");
      expect(data.kind === "scroll_to_text" ? data.x : null).toBe(0);
      expect("signals" in result).toBe(false);
    }
  });

  test("a failed evidence runtime keeps dispatch-level scrolling intact", async () => {
    const failing = (): never => {
      throw new Error("not used");
    };
    const runtime: BrowserActionRuntime = {
      selectedTabId: 7,
      navigate: failing,
      goBack: failing,
      refresh: failing,
      click: failing,
      type: failing,
      clearInput: failing,
      keypress: failing,
      scroll: failing,
      scrollToText: failing,
      getSelectOptions: failing,
      selectOption: failing,
      openTab: failing,
      switchTab: failing,
      closeTab: failing,
      listTabs: failing,
    };
    const outcome = await dispatchBrowserAction(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: { mode: { mode: "top" } } },
      runtime,
      { signal: new AbortController().signal, timeoutMs: 500, expectation: null },
    );
    expect(outcome).toEqual({
      ok: false,
      action: "browser_scroll",
      tabId: 7,
      error: { code: "action_failed", message: "Browser action failed" },
    });
  });
});
