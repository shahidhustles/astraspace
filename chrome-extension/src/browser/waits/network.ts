import type { HTTPRequest, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { NetworkSignal, SettleTimings } from "./types";

// Resource kinds whose whole lifecycle must settle before an action reports
// completion. Child-frame documents arrive on this same page stream as
// "document" requests; there is no separate frame-level stream to watch.
const TRACKED_RESOURCE_TYPES = new Set(["document", "xhr", "fetch", "script", "stylesheet"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Watches relevant network requests on one page and measures quiet spans.
// Long-lived or irrelevant requests (websocket, eventsource, media, ...) are
// only counted as ignored evidence and never move the quiet clock.
export class NetworkActivityWatcher {
  static arm(page: Page, timings: SettleTimings): NetworkActivityWatcher {
    return new NetworkActivityWatcher(page, timings);
  }

  private readonly page: Page;
  private readonly timings: SettleTimings;
  private readonly tracked = new Set<HTTPRequest>();
  private ignoredRequests = 0;
  private lastActivityAt = Date.now();
  private disposed = false;

  private readonly onRequest = (request: HTTPRequest): void => {
    if (this.disposed) {
      return;
    }
    if (TRACKED_RESOURCE_TYPES.has(request.resourceType())) {
      this.tracked.add(request);
      this.lastActivityAt = Date.now();
    } else {
      this.ignoredRequests += 1;
    }
  };

  private readonly onSettled = (request: HTTPRequest): void => {
    if (this.disposed || !this.tracked.delete(request)) {
      return;
    }
    this.lastActivityAt = Date.now();
  };

  private constructor(page: Page, timings: SettleTimings) {
    this.page = page;
    this.timings = timings;
    this.page.on("request", this.onRequest);
    this.page.on("requestfinished", this.onSettled);
    this.page.on("requestfailed", this.onSettled);
  }

  // Resolves once no tracked request has started or settled for
  // timings.networkQuietMs. Resolves early with "cancelled" when signal fires.
  async waitForQuiet(timeoutMs: number | null, signal?: AbortSignal): Promise<NetworkSignal> {
    const deadline =
      timeoutMs === null ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    for (;;) {
      const idleMs = Date.now() - this.lastActivityAt;
      if (idleMs >= this.timings.networkQuietMs) {
        return { status: "quiet", idleMs, ignoredRequests: this.ignoredRequests };
      }
      if (signal?.aborted) {
        return { status: "cancelled", ignoredRequests: this.ignoredRequests };
      }
      if (timeoutMs !== null && Date.now() >= deadline) {
        return {
          status: "activity_timeout",
          timeoutMs,
          pendingCount: this.tracked.size,
          ignoredRequests: this.ignoredRequests,
        };
      }
      await sleep(this.timings.pollMs);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.page.off("request", this.onRequest);
    this.page.off("requestfinished", this.onSettled);
    this.page.off("requestfailed", this.onSettled);
    this.tracked.clear();
  }
}
