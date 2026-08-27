import type { Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { LayoutSignal, SettleTimings } from "./types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Interactive landmarks measured in document order. The fixed selector list
// keeps consecutive samples comparable: same elements sampled in the same
// order, with element count changes surfacing as a delta.
export function layoutSampleSource(): string {
  return `(function () {
  var SELECTOR = "a[href], button, input, select, textarea, h1, h2, h3, li, [role]";
  var els = document.querySelectorAll(SELECTOR);
  var rects = [];
  for (var i = 0; i < els.length && rects.length < 120; i++) {
    var el = els[i];
    if (!el.isConnected) { continue; }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { continue; }
    rects.push(
      Math.round(rect.left + window.scrollX),
      Math.round(rect.top + window.scrollY),
      Math.round(rect.width),
      Math.round(rect.height)
    );
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    landmarks: rects,
  };
})()`;
}

interface FrameLayoutSample {
  width: unknown;
  height: unknown;
  scrollWidth: unknown;
  scrollHeight: unknown;
  landmarks: unknown;
}

function numericArray(sample: FrameLayoutSample): number[] {
  const out: number[] = [];
  for (const key of ["width", "height", "scrollWidth", "scrollHeight"] as const) {
    const value = sample[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push(value);
    }
  }
  if (Array.isArray(sample.landmarks)) {
    for (const entry of sample.landmarks) {
      if (typeof entry === "number" && Number.isFinite(entry)) {
        out.push(entry);
      }
    }
  }
  return out;
}

function maxDelta(left: number[], right: number[]): number | null {
  const length = Math.min(left.length, right.length);
  // A vanishing or appearing frame yields no comparable numbers.
  if (length === 0) {
    return null;
  }
  let delta = Math.abs(left.length - right.length);
  for (let i = 0; i < length; i++) {
    delta = Math.max(delta, Math.abs(left[i] - right[i]));
  }
  return delta;
}

async function measurePage(page: Page): Promise<number[]> {
  const frames = page.frames();
  const results = await Promise.allSettled(
    frames.map(async (frame: Frame) => {
      const raw: unknown = await frame.evaluate(layoutSampleSource());
      return numericArray(raw as FrameLayoutSample);
    }),
  );
  return results.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
}

// Compares page geometry taken twice at least the configured span apart. Every
// rendered rect must sit within tolerance of its previous position; anything
// larger keeps the page unstable until the budget runs out.
export class LayoutStabilityWatcher {
  private readonly page: Page;
  private readonly timings: SettleTimings;

  constructor(page: Page, timings: SettleTimings) {
    this.page = page;
    this.timings = timings;
  }

  async waitForStable(timeoutMs: number | null, signal?: AbortSignal): Promise<LayoutSignal> {
    const deadline =
      timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    let worstDelta = 0;
    let pairs = 0;
    for (;;) {
      const before = await measurePage(this.page);
      await sleep(this.timings.layoutSampleSpanMs);
      if (signal?.aborted) {
        return { status: "cancelled" };
      }
      const after = await measurePage(this.page);
      const delta = maxDelta(before, after);
      if (delta !== null) {
        pairs += 1;
        worstDelta = Math.max(worstDelta, delta);
        if (delta <= this.timings.layoutTolerancePx) {
          return { status: "stable", samples: 2, maxDeltaPx: delta };
        }
      }
      if (signal?.aborted) {
        return { status: "cancelled" };
      }
      if (Date.now() >= deadline) {
        return { status: "unstable", timeoutMs: timeoutMs ?? 0, sampleCount: pairs * 2, maxDeltaPx: worstDelta };
      }
    }
  }
}
