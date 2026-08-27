import type { Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { DomSignal, SettleTimings } from "./types";

// One global key is safe because ticket-01 serialization keeps a single
// settlement alive per tab at any moment.
const DOM_WATCH_KEY = "__astraDomWatch";

// Sources are plain expression strings so they can be evaluated on any frame
// without shipping functions across contexts.
export function domObserverInstallSource(): string {
  return `(function () {
  if (window[${JSON.stringify(DOM_WATCH_KEY)}]) { return false; }
  var count = 0;
  try {
    var observer = new MutationObserver(function (records) { count += records.length; });
    var options = { subtree: true, childList: true, attributes: true, characterData: true };
    observer.observe(document.documentElement, options);
    var elements = document.querySelectorAll("*");
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].shadowRoot) { observer.observe(elements[i].shadowRoot, options); }
    }
    window[${JSON.stringify(DOM_WATCH_KEY)}] = {
      active: true,
      count: function () { return count; },
      disconnect: function () { observer.disconnect(); }
    };
    return true;
  } catch (error) {
    return false;
  }
})()`;
}

export function domObserverCountSource(): string {
  return `(function () {
  var watch = window[${JSON.stringify(DOM_WATCH_KEY)}];
  return watch && watch.active ? watch.count() : -1;
})()`;
}

export function domObserverUninstallSource(): string {
  return `(function () {
  var watch = window[${JSON.stringify(DOM_WATCH_KEY)}];
  if (!watch || !watch.active) { return false; }
  if (watch.disconnect) { watch.disconnect(); }
  watch.active = false;
  return true;
})()`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Installs a mutation counter into every currently live frame of the page and
// measures quiet spans over their combined DOM activity. Frames that cannot be
// reached are skipped instead of blocking settling.
export class DomActivityWatcher {
  static async arm(page: Page, timings: SettleTimings): Promise<DomActivityWatcher> {
    const watcher = new DomActivityWatcher(page, timings);
    await watcher.install();
    return watcher;
  }

  private readonly page: Page;
  private readonly timings: SettleTimings;
  private readonly watched = new Map<Frame, number>();
  private lastActivityAt = Date.now();
  private disposed = false;

  private readonly onFrameDetached = (frame: Frame): void => {
    this.watched.delete(frame);
  };

  private constructor(page: Page, timings: SettleTimings) {
    this.page = page;
    this.timings = timings;
    this.page.on("framedetached", this.onFrameDetached);
  }

  private async install(): Promise<void> {
    const frames = this.page.frames();
    await Promise.allSettled(frames.map((frame) => this.attach(frame)));
  }

  private async attach(frame: Frame): Promise<boolean> {
    try {
      const installed = await frame.evaluate(domObserverInstallSource());
      if (installed === true) {
        this.watched.set(frame, -1);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async waitForQuiet(timeoutMs: number | null, signal?: AbortSignal): Promise<DomSignal> {
    const deadline =
      timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    for (;;) {
      await this.readFrames();
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.timings.domQuietMs) {
        return { status: "quiet", idleMs, watchedFrames: this.watched.size };
      }
      if (signal?.aborted) {
        return { status: "cancelled", watchedFrames: this.watched.size };
      }
      if (timeoutMs !== null && Date.now() >= deadline) {
        return { status: "activity_timeout", timeoutMs, watchedFrames: this.watched.size };
      }
      await sleep(this.timings.pollMs);
    }
  }

  private async readFrames(): Promise<void> {
    let activity = false;
    for (const [frame, previous] of this.watched) {
      let count: number;
      try {
        const raw: unknown = await frame.evaluate(domObserverCountSource());
        count = typeof raw === "number" ? raw : -1;
      } catch {
        // A frame mid-navigation or gone from the tree stops contributing.
        continue;
      }
      if (count < 0) {
        this.watched.delete(frame);
        continue;
      }
      if (count !== previous) {
        this.watched.set(frame, count);
        activity = true;
      }
    }
    if (activity) {
      this.lastActivityAt = Date.now();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.page.off("framedetached", this.onFrameDetached);
    for (const frame of this.watched.keys()) {
      void frame.evaluate(domObserverUninstallSource()).catch(() => {});
    }
    this.watched.clear();
  }
}
