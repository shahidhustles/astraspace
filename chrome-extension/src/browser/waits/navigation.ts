import type { Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { FrameGraphTracker } from "../document-identity";
import {
  domObserverCountSource,
  domObserverInstallSource,
  domObserverUninstallSource,
} from "./dom";
import { NetworkActivityWatcher } from "./network";
import type {
  ActionSettleSignals,
  CommitExpectation,
  CommitWaitOutcome,
  DomSignal,
  NavigationCommitRecord,
  SettleTimings,
} from "./types";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function matchesExpectation(record: NavigationCommitRecord, expected: CommitExpectation): boolean {
  if (record.kind === "main_commit") {
    return true;
  }
  return record.kind === "same_document" && expected.acceptsSameDocument;
}

// Arms one navigation's evidence collectors: commit records streamed from the
// frame graph tracker, relevant request tracking, and DOM observers that
// reinstall themselves when a navigation destroys their execution context.
// Arm before the Puppeteer navigation call so nothing escapes measurement.
export class NavigationWatcher {
  static async arm(page: Page, tracker: FrameGraphTracker, timings: SettleTimings): Promise<NavigationWatcher> {
    const watcher = new NavigationWatcher(page, tracker, timings);
    await watcher.installDomObservers();
    return watcher;
  }

  private readonly page: Page;
  private readonly timings: SettleTimings;
  private readonly network: NetworkActivityWatcher;
  private readonly commits: NavigationCommitRecord[] = [];
  // Per-frame mutation counts. A stored -1 means installed but not yet read,
  // so the first count becomes the baseline instead of fake activity.
  private readonly watched = new Map<Frame, number>();
  private lastDomActivityAt = Date.now();
  private disposed = false;

  private readonly unsubscribe: () => void;
  private pending:
    | {
        expected: CommitExpectation;
        resolve: (outcome: CommitWaitOutcome) => void;
      }
    | null = null;

  private constructor(page: Page, tracker: FrameGraphTracker, timings: SettleTimings) {
    this.page = page;
    this.timings = timings;
    this.network = NetworkActivityWatcher.arm(page, timings);
    this.unsubscribe = tracker.onCommit((record) => {
      if (this.disposed) {
        return;
      }
      this.commits.push(record);
      const waiting = this.pending;
      if (waiting && matchesExpectation(record, waiting.expected)) {
        this.pending = null;
        waiting.resolve({ status: "matched", match: record });
      }
    });
  }

  // Every hop recorded so far, including ones that landed after the matched
  // commit — callers report after the quiet window, when late hops exist.
  allCommits(): NavigationCommitRecord[] {
    return [...this.commits];
  }

  // Resolves on the first main-frame or accepted same-document signal. Child
  // commits only accumulate as evidence.
  async waitForCommit(
    expected: CommitExpectation,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<CommitWaitOutcome> {
    const seen = this.commits.find((record) => matchesExpectation(record, expected));
    if (seen) {
      return { status: "matched", match: seen };
    }
    const deadline = Date.now() + timeoutMs;
    const matched = new Promise<CommitWaitOutcome>((resolve) => {
      this.pending = { expected, resolve };
    });
    for (;;) {
      const outcome = await Promise.race([matched, sleep(this.timings.pollMs).then(() => null)]);
      if (outcome) {
        return outcome;
      }
      if (signal?.aborted) {
        this.pending = null;
        return { status: "cancelled" };
      }
      if (Date.now() >= deadline) {
        this.pending = null;
        return { status: "timeout", timeoutMs };
      }
    }
  }

  async waitForQuiet(timeoutMs: number, signal?: AbortSignal): Promise<ActionSettleSignals> {
    const [network, dom] = await Promise.all([
      this.network.waitForQuiet(timeoutMs, signal),
      this.waitForDomQuiet(timeoutMs, signal),
    ]);
    return { network, dom };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe();
    for (const frame of [...this.watched.keys()]) {
      void frame.evaluate(domObserverUninstallSource()).catch(() => {});
    }
    this.watched.clear();
    this.network.dispose();
  }

  private async installDomObservers(): Promise<void> {
    await Promise.allSettled(this.page.frames().map((frame) => this.attach(frame)));
  }

  private async attach(frame: Frame): Promise<boolean> {
    try {
      const installed = await frame.evaluate(domObserverInstallSource());
      if (installed === true && !this.watched.has(frame)) {
        this.watched.set(frame, -1);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async waitForDomQuiet(timeoutMs: number, signal?: AbortSignal): Promise<DomSignal> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.sweepFrames();
      const idleMs = Date.now() - this.lastDomActivityAt;
      if (idleMs >= this.timings.domQuietMs) {
        return { status: "quiet", idleMs, watchedFrames: this.watched.size };
      }
      if (signal?.aborted) {
        return { status: "cancelled", watchedFrames: this.watched.size };
      }
      if (Date.now() >= deadline) {
        return { status: "activity_timeout", timeoutMs, watchedFrames: this.watched.size };
      }
      await sleep(this.timings.pollMs);
    }
  }

  // Reads every live frame's mutation counter. Frames whose execution context
  // died get their observer reinstalled on the same Puppeteer frame; frames
  // removed from the tree drop out entirely.
  private async sweepFrames(): Promise<void> {
    const live = new Set(this.page.frames());
    for (const frame of [...this.watched.keys()]) {
      if (!live.has(frame)) {
        this.watched.delete(frame);
      }
    }
    let activity = false;
    for (const frame of live) {
      const previous = this.watched.get(frame);
      let count: number | null = null;
      try {
        const raw: unknown = await frame.evaluate(domObserverCountSource());
        if (typeof raw === "number" && raw >= 0) {
          count = raw;
        }
      } catch {
        count = null;
      }
      if (count === null) {
        this.watched.delete(frame);
        const reinstalled = await this.attach(frame);
        // Replacing an established watch means the document was swapped, so
        // the quiet clock restarts; a first install stays silent.
        if (reinstalled && previous !== undefined && previous >= 0) {
          activity = true;
        }
        continue;
      }
      if (previous === undefined || previous === -1) {
        this.watched.set(frame, count);
        continue;
      }
      if (count !== previous) {
        this.watched.set(frame, count);
        activity = true;
      }
    }
    if (activity) {
      this.lastDomActivityAt = Date.now();
    }
  }
}
