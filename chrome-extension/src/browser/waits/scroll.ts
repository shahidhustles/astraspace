import type { ElementHandle, Frame } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ActionSettleSignals, ScrollStabilitySignal, SettleTimings } from "./types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Position of the scrolling surface at one instant.
export interface ScrollSample {
  x: number;
  y: number;
}

// A captured window onto one scrolling surface. Probes are created before a
// snapshot invalidation and only ever queried afterwards, so no grounded
// target gets re-resolved during the wait. read() resolves null once the
// surface is detached or removed.
export interface ScrollSurfaceProbe {
  read: () => Promise<ScrollSample | null>;
}

// Evaluated on any frame; reads the document's own scroll offset.
export function documentScrollSampleSource(): string {
  return `(function () {
    var el = document.scrollingElement || document.documentElement;
    return { x: el.scrollLeft, y: el.scrollTop };
  })()`;
}

// Runs inside the page through Puppeteer, so it stays self-contained. Walks
// from the anchor element up through shadow boundaries to the container
// applyContainerScroll wrote to. Without an inner scroller the anchor rides
// on the document itself; an unconnected anchor means the surface is gone.
export function surfaceScrollSample(el: Element): ScrollSample | null {
  let current: Element | null = el;
  while (current) {
    if (current.scrollHeight > current.clientHeight) {
      const overflowY = getComputedStyle(current).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return { x: current.scrollLeft, y: current.scrollTop };
      }
    }
    const parent: Node | null = current.parentNode;
    current = parent instanceof ShadowRoot ? parent.host : current.parentElement;
  }
  return el.isConnected ? { x: window.scrollX, y: window.scrollY } : null;
}

function asScrollSample(raw: unknown): ScrollSample | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { x, y } = raw as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

export function documentProbe(frame: Frame): ScrollSurfaceProbe {
  return {
    read: async () => {
      try {
        return asScrollSample(await frame.evaluate(documentScrollSampleSource()));
      } catch {
        return null;
      }
    },
  };
}

export function anchorProbe(element: ElementHandle<Element>): ScrollSurfaceProbe {
  return {
    read: async () => {
      try {
        return asScrollSample(await element.evaluate(surfaceScrollSample));
      } catch {
        return null;
      }
    },
  };
}

export interface ScrollSettleInput {
  probe: ScrollSurfaceProbe;
  targetY: number;
  timings: SettleTimings;
  timeoutMs: number | null;
  signal?: AbortSignal;
  // Network/DOM quiet measured by watchers armed before the scroll ran. The
  // barrier starts reading it immediately so lazy content loaded by the
  // scroll extends completion instead of racing it.
  waitForQuiet?: () => Promise<ActionSettleSignals>;
}

export interface ScrollSettlement {
  stability: ScrollStabilitySignal;
  signals?: ActionSettleSignals;
}

async function collectQuiet(quiet?: Promise<ActionSettleSignals>): Promise<ActionSettleSignals | undefined> {
  if (!quiet) {
    return undefined;
  }
  try {
    return await quiet;
  } catch {
    return undefined;
  }
}

// Holds until the requested offset is reached and two samples one span apart
// agree within tolerance, or a bounded outcome ends the wait early: the
// surface vanished, the caller aborted, or the budget expired with the
// position still short of (unreachable) or drifting around (unstable) the
// target.
export async function waitForScrollSettled(input: ScrollSettleInput): Promise<ScrollSettlement> {
  const { probe, timings, signal, targetY } = input;
  const startedAt = Date.now();
  const cap = input.timeoutMs === null ? Number.POSITIVE_INFINITY : input.timeoutMs;

  // Quiet reading starts with the sampling so lazy content loaded by the
  // scroll extends completion instead of racing it. Every exit awaits it,
  // which is instant once aborted because the watchers stop on the signal.
  const quietPromise = input.waitForQuiet?.();
  const finish = async (stability: ScrollStabilitySignal): Promise<ScrollSettlement> => {
    const signals = await collectQuiet(quietPromise);
    return signals ? { stability, signals } : { stability };
  };

  let worstDelta = 0;
  let samples = 0;
  let lastY: number | null = null;
  let everReached = false;

  function unsettle(reason: "unreachable" | "unstable"): ScrollStabilitySignal {
    return {
      status: "unsettled",
      reason,
      timeoutMs: cap === Number.POSITIVE_INFINITY ? 0 : Date.now() - startedAt,
      sampleCount: samples,
      maxDeltaPx: worstDelta,
      targetY,
      lastY,
    };
  }

  for (;;) {
    if (signal?.aborted) {
      return finish({ status: "cancelled" });
    }
    const first = await probe.read();
    samples += 1;
    if (!first) {
      return finish(unsettle("unreachable"));
    }
    const reachedFirst = Math.abs(first.y - targetY) <= timings.layoutTolerancePx;
    everReached ||= reachedFirst;
    lastY = first.y;

    await sleep(timings.layoutSampleSpanMs);
    if (signal?.aborted) {
      return finish({ status: "cancelled" });
    }
    const second = await probe.read();
    samples += 1;
    if (!second) {
      return finish(unsettle("unreachable"));
    }
    const delta = Math.max(Math.abs(second.x - first.x), Math.abs(second.y - first.y));
    worstDelta = Math.max(worstDelta, delta);
    const reachedSecond = Math.abs(second.y - targetY) <= timings.layoutTolerancePx;
    everReached ||= reachedSecond;
    lastY = second.y;

    if (reachedFirst && reachedSecond && delta <= timings.layoutTolerancePx) {
      return finish({ status: "stable", samples: 2, maxDeltaPx: delta });
    }

    if (Date.now() >= startedAt + cap) {
      return finish(unsettle(everReached ? "unstable" : "unreachable"));
    }
  }
}
