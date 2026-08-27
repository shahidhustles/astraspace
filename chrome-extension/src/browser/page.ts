import {
  connect,
  ExtensionTransport,
  type Browser,
  type CDPSession,
  type Frame,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { FrameGraphTracker, lineageStepMatchesLive, type FrameRecord } from "./document-identity";
import { bindFrameGraph } from "./frame-binding";
import {
  buildHighlightOverlayExpression,
  clipToRect,
  enrichPageContentWithAccessibility,
  observePageExpression,
  readJpegDimensions,
  removeHighlightOverlayExpression,
  renderPageContent,
  toObservedRef,
  type ExtractedFrame,
  type ExtractedFrameContent,
  type ExtractedNode,
  type ExtractedPageContent,
  type FrameLineageStep,
  type GroundingRecord,
  type ObservedRef,
  type PathStep,
  type RectBounds,
  type ScrollState,
  type ViewportCapture,
  type ViewportMeasurements,
} from "./observation";
import type { OwnerMap } from "./observation/extract";
import { SnapshotStore } from "./snapshot";
import { resolveTarget } from "./target-resolution";
import { enforceUrlPolicy, redirectPolicyError } from "./url-policy";
import { clickGroundedTarget } from "./actions/element";
import { clearGroundedTarget, typeGroundedTarget } from "./actions/input";
import { keypressGroundedTarget } from "./actions/keyboard";
import { registerNewTabDetector } from "./actions/new-tab";
import { scrollGroundedTarget, scrollToVisibleText } from "./actions/scroll";
import { getSelectOptions, selectOption } from "./actions/select";
import type {
  ActionCancelledError,
  ActionExpectationPolicy,
  ClearInputResult,
  ClickCapture,
  ClickMeasurement,
  ClickResult,
  GetSelectOptionsResult,
  KeypressInput,
  KeypressResult,
  ScrollInput,
  ScrollResult,
  SelectOptionIdentity,
  SelectOptionResult,
  TypeResult,
} from "./actions/types";
import { DomActivityWatcher } from "./waits/dom";
import { waitForExpectationSignal } from "./waits/expectation";
import { LayoutStabilityWatcher } from "./waits/layout";
import { NavigationWatcher } from "./waits/navigation";
import { NetworkActivityWatcher } from "./waits/network";
import { waitForScrollSettled, type ScrollSettlement, type ScrollSurfaceProbe } from "./waits/scroll";
import {
  resolveSettleTimings,
  boundText,
  boundedCommits,
  type ActionSettleContext,
  type ActionSettleSignals,
  type CommitExpectation,
  type ExpectationSignal,
  type NavigationCommitRecord,
  type SettleTimings,
} from "./waits/types";
import type {
  BrowserError,
  GroundedTarget,
  ObserveResult,
  TargetResolutionResult,
  UrlPolicyResult,
} from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const SCREENSHOT_QUALITY = 85;

export interface PageDeps {
  connect: (options: Parameters<typeof connect>[0]) => Promise<Browser>;
  connectTab: (tabId: number) => Promise<ExtensionTransport>;
  timeoutMs: number;
  snapshotStore?: SnapshotStore;
  onCreated?: (listener: (tab: chrome.tabs.Tab) => void) => () => void;
  settleTimings?: Partial<SettleTimings>;
  // Fires when a live connection dies unexpectedly mid-use (not on teardown
  // the context itself initiated), so action scheduling can abort its waits.
  onConnectionReplaced?: (tabId: number) => void;
}

export type AttachResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

// Successful navigations prove the commit that landed, the identity it gave
// the document, every hop recorded along the way, and the quiet state after.
export interface NavigationReport {
  commitType: "commit" | "same_document";
  documentEpoch: number;
  navigationEpoch: number;
  commits: NavigationCommitRecord[];
  signals: ActionSettleSignals;
}

export type NavResult =
  | ({ ok: true; url: string } & NavigationReport)
  | { ok: true; url: string; timedOut: true }
  | { ok: false; error: BrowserError | ActionCancelledError };

export type DisconnectResult = { ok: true } | { ok: false; error: BrowserError };

export interface StagedObservation {
  tabId: number;
  url: string;
  title: string;
  scroll: ScrollState;
  dom: string;
  refs: ObservedRef[];
  groundings: GroundingRecord[];
  screenshot: ViewportCapture;
  documentEpoch: number;
  navigationEpoch: number;
  graphVersion: number;
  connectionGeneration: number;
}

export type StageResult = { ok: true; staged: StagedObservation } | { ok: false; error: BrowserError };

interface FrameOverlay {
  frame: Frame;
  refs: ObservedRef[];
  viewport: ViewportMeasurements;
}

interface ExtractedFrameTreeResult {
  content: ExtractedPageContent;
  nextRef: number;
  overlays: FrameOverlay[];
}

interface FrameOwnerGeometry {
  contentRect: RectBounds;
  scaleX: number;
  scaleY: number;
}

interface PageWithClient extends Page {
  _client: () => CDPSession;
}

function hasCdpClient(page: Page): page is PageWithClient {
  return "_client" in page && typeof page._client === "function";
}

export class BrowserPage {
  readonly tabId: number;
  readonly url: string;

  private readonly deps: PageDeps;
  private readonly policy: UrlPolicyResult;
  private readonly snapshots: SnapshotStore;
  private browser: Browser | null = null;
  private puppeteerPage: Page | null = null;
  private session: CDPSession | null = null;
  private identityTracker: FrameGraphTracker | null = null;
  private observationQueue: Promise<void> = Promise.resolve();
  private connectionGeneration = 0;

  constructor(tabId: number, url: string, deps: PageDeps = defaultPageDeps) {
    this.tabId = tabId;
    this.url = url;
    this.deps = deps;
    this.policy = enforceUrlPolicy(url);
    this.snapshots = deps.snapshotStore ?? new SnapshotStore();
  }

  get attached(): boolean {
    return this.browser !== null && this.puppeteerPage !== null;
  }

  get page(): Page | null {
    return this.puppeteerPage;
  }

  async attach(): Promise<AttachResult> {
    if (this.attached) {
      return { ok: true, tabId: this.tabId };
    }
    if (!this.policy.ok) {
      return { ok: false, error: this.policy.error };
    }

    let browser: Browser | null = null;
    try {
      browser = await this.deps.connect({
        transport: await this.deps.connectTab(this.tabId),
        protocol: "cdp",
        defaultViewport: null,
      });
      const [page] = await browser.pages();
      if (!page) {
        await browser.disconnect();
        return { ok: false, error: { code: "attach_failed", message: "Connection exposed no page" } };
      }
      if (!hasCdpClient(page)) {
        await browser.disconnect();
        return { ok: false, error: { code: "attach_failed", message: "Connection exposed no CDP client" } };
      }
      const session = page._client();
      const identityTracker = await FrameGraphTracker.create(
        session,
        () => this.snapshots.invalidate(this.tabId),
        { detachOnDispose: false },
      );
      this.browser = browser;
      this.puppeteerPage = page;
      this.session = session;
      this.identityTracker = identityTracker;
      this.connectionGeneration += 1;
      return { ok: true, tabId: this.tabId };
    } catch (error) {
      if (browser) {
        await browser.disconnect();
      }
      if (error instanceof Error && /already attached/i.test(error.message)) {
        return { ok: false, error: { code: "attach_conflict", message: "Another debugger is attached to the tab" } };
      }
      return { ok: false, error: { code: "attach_failed", message: "Failed to attach to tab" } };
    }
  }

  async disconnect(): Promise<DisconnectResult> {
    const browser = this.browser;
    this.connectionGeneration += 1;
    this.browser = null;
    this.puppeteerPage = null;
    this.session = null;
    this.identityTracker?.dispose();
    this.identityTracker = null;
    this.snapshots.invalidate(this.tabId);
    if (!browser) {
      return { ok: true };
    }
    try {
      await browser.disconnect();
      return { ok: true };
    } catch {
      return { ok: false, error: { code: "disconnect_failed", message: "Failed to disconnect from tab" } };
    }
  }

  async navigate(url: string, settle?: ActionSettleContext): Promise<NavResult> {
    const policy = enforceUrlPolicy(url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }
    return this.runNavigation((page) => page.goto(url, this.navOptions()), { acceptsSameDocument: false }, settle);
  }

  async goBack(settle?: ActionSettleContext): Promise<NavResult> {
    // History may step between same-document entries, so back accepts both
    // commit shapes.
    return this.runNavigation((page) => page.goBack(this.navOptions()), { acceptsSameDocument: true }, settle);
  }

  async reload(settle?: ActionSettleContext): Promise<NavResult> {
    return this.runNavigation((page) => page.reload(this.navOptions()), { acceptsSameDocument: false }, settle);
  }

  async click(target: GroundedTarget, settle?: ActionSettleContext): Promise<ClickResult> {
    const activation = this.prepareActivation(settle);
    try {
      return await clickGroundedTarget(target, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        settle: () => activation.capture(),
        finishActivation: () => activation.finish(),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
      });
    } finally {
      activation.finish();
    }
  }

  async type(target: GroundedTarget, text: string, settle?: ActionSettleContext): Promise<TypeResult> {
    return this.withSettlement(settle, (waitForSignals) =>
      typeGroundedTarget(target, text, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        settle: waitForSignals ? () => waitForSignals() : undefined,
      }),
    );
  }

  async clearInput(target: GroundedTarget, settle?: ActionSettleContext): Promise<ClearInputResult> {
    return this.withSettlement(settle, (waitForSignals) =>
      clearGroundedTarget(target, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        settle: waitForSignals ? () => waitForSignals() : undefined,
      }),
    );
  }

  async keypress(input: KeypressInput, settle?: ActionSettleContext): Promise<KeypressResult> {
    return this.withSettlement(settle, (waitForSignals) =>
      keypressGroundedTarget(input, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        keyboard: () => (this.attached ? (this.puppeteerPage?.keyboard ?? null) : null),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        settle: waitForSignals ? () => waitForSignals() : undefined,
      }),
    );
  }

  async scroll(input: ScrollInput, settle?: ActionSettleContext): Promise<ScrollResult> {
    return this.withScrollSettlement(settle, (waitSettled) =>
      scrollGroundedTarget(input.target ?? null, input.mode, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        frame: () => this.puppeteerPage?.mainFrame() ?? null,
        settle: waitSettled,
      }),
    );
  }

  async scrollToText(text: string, occurrence: number, settle?: ActionSettleContext): Promise<ScrollResult> {
    return this.withScrollSettlement(settle, (waitSettled) =>
      scrollToVisibleText(text, occurrence, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        frame: () => this.puppeteerPage?.mainFrame() ?? null,
        settle: waitSettled,
      }),
    );
  }

  async getSelectOptions(target: GroundedTarget): Promise<GetSelectOptionsResult> {
    return getSelectOptions(target, {
      resolveTarget: (resolved) => this.resolveTarget(resolved),
      invalidate: () => this.snapshots.invalidate(this.tabId),
      currentUrl: () => this.puppeteerPage?.url() ?? "",
    });
  }

  async selectOption(target: GroundedTarget, option: SelectOptionIdentity, settle?: ActionSettleContext): Promise<SelectOptionResult> {
    return this.withSettlement(settle, (waitForSignals) =>
      selectOption(target, option, {
        resolveTarget: (resolved) => this.resolveTarget(resolved),
        invalidate: () => this.snapshots.invalidate(this.tabId),
        currentUrl: () => this.puppeteerPage?.url() ?? "",
        settle: waitForSignals ? () => waitForSignals() : undefined,
      }),
    );
  }

  observe(): Promise<ObserveResult> {
    const result = this.observationQueue.then(() => this.performObservation());
    this.observationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // Arms network and DOM watchers before the edit runs so no page activity
  // escapes measurement. Watchers are removed when the helper consumes its
  // signals, or right here when the helper fails before settling.
  private async withSettlement<R>(
    settle: ActionSettleContext | undefined,
    run: (waitForSignals: (() => Promise<ActionSettleSignals>) | undefined) => Promise<R>,
  ): Promise<R> {
    if (!settle || !this.attached || !this.puppeteerPage) {
      return run(undefined);
    }
    const timings = resolveSettleTimings(this.deps.settleTimings);
    const pair = await this.armQuietPair(timings);
    let consumed = false;
    const waitForSignals = async (): Promise<ActionSettleSignals> => {
      consumed = true;
      return pair.collect(settle.timeoutMs, settle.signal);
    };
    try {
      return await run(waitForSignals);
    } finally {
      if (!consumed) {
        pair.disposeOnce();
      }
    }
  }

  // Same watcher pair as withSettlement, but the quiet reading starts inside
  // the scroll barrier so position sampling and lazy-loaded content settle
  // together under one budget.
  private async withScrollSettlement(
    settle: ActionSettleContext | undefined,
    run: (
      waitSettled:
        | ((request: { probe: ScrollSurfaceProbe; targetY: number }) => Promise<ScrollSettlement>)
        | undefined,
    ) => Promise<ScrollResult>,
  ): Promise<ScrollResult> {
    if (!settle || !this.attached || !this.puppeteerPage) {
      return run(undefined);
    }
    const timings = resolveSettleTimings(this.deps.settleTimings);
    const pair = await this.armQuietPair(timings);
    const capMs = settle.timeoutMs ?? this.deps.timeoutMs;
    let consumed = false;
    const waitSettled = ({ probe, targetY }: { probe: ScrollSurfaceProbe; targetY: number }): Promise<ScrollSettlement> => {
      consumed = true;
      return waitForScrollSettled({
        probe,
        targetY,
        timings,
        timeoutMs: capMs,
        signal: settle.signal,
        waitForQuiet: () => pair.collect(capMs, settle.signal),
      });
    };
    try {
      return await run(waitSettled);
    } finally {
      if (!consumed) {
        pair.disposeOnce();
      }
    }
  }

  // Arms one network and one DOM watcher per action. collect() awaits both
  // quiet readings and disposes them; disposeOnce covers paths that never
  // reached collection.
  private async armQuietPair(timings: SettleTimings): Promise<{
    collect: (timeoutMs: number | null, signal?: AbortSignal) => Promise<ActionSettleSignals>;
    disposeOnce: () => void;
  }> {
    const page = this.puppeteerPage as Page;
    const network = NetworkActivityWatcher.arm(page, timings);
    const dom = await DomActivityWatcher.arm(page, timings);
    let disposed = false;
    const disposeOnce = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      // Watcher disposal can race a closing transport; teardown must never
      // mask the action's own result.
      try {
        dom.dispose();
        network.dispose();
      } catch {
        // ignore
      }
    };
    return {
      collect: async (timeoutMs, signal) => {
        try {
          const [networkSignal, domSignal] = await Promise.all([
            network.waitForQuiet(timeoutMs, signal),
            dom.waitForQuiet(timeoutMs, signal),
          ]);
          return { network: networkSignal, dom: domSignal };
        } finally {
          disposeOnce();
        }
      },
      disposeOnce,
    };
  }

  private async performObservation(): Promise<ObserveResult> {
    const staged = await this.stageObservation();
    if (!staged.ok) {
      return staged;
    }
    return this.commitObservation(staged.staged);
  }

  async stageObservation(): Promise<StageResult> {
    if (!this.attached || !this.puppeteerPage) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    if (!this.policy.ok) {
      return { ok: false, error: this.policy.error };
    }
    const tracker = this.identityTracker;
    if (!tracker) {
      return this.failCapture();
    }
    const page = this.puppeteerPage;
    const url = page.url();
    const currentPolicy = enforceUrlPolicy(url);
    if (!currentPolicy.ok) {
      this.snapshots.invalidate(this.tabId);
      return { ok: false, error: currentPolicy.error };
    }
    const identityBefore = tracker.identity;
    const graphVersionBefore = tracker.version;

    try {
      const title = await page.title();
      const extracted = await this.extractFrameTree();
      if (!extracted) {
        return this.failCapture();
      }
      const { content, overlays } = extracted;
      if (tracker.version !== graphVersionBefore) {
        return this.failCapture();
      }
      const rendered = renderPageContent(content);
      const refs = rendered.refs;
      const viewport = content.viewport;
      const captureId = crypto.randomUUID();

      let data: string;
      try {
        for (const overlay of overlays) {
          await overlay.frame.evaluate(
            buildHighlightOverlayExpression(overlay.refs, overlay.viewport, captureId),
          );
        }
        data = (await page.screenshot({
          type: "jpeg",
          quality: SCREENSHOT_QUALITY,
          encoding: "base64",
        })) as string;
      } finally {
        const removals = await Promise.allSettled(
          overlays.map((overlay) =>
            overlay.frame.evaluate(removeHighlightOverlayExpression(captureId)),
          ),
        );
        if (removals.some((result) => result.status === "rejected")) {
          throw new Error("Failed to remove observation overlays");
        }
      }

      const finalUrl = page.url();
      if (finalUrl !== url || !enforceUrlPolicy(finalUrl).ok) {
        return this.failCapture();
      }
      if (tracker.version !== graphVersionBefore) {
        return this.failCapture();
      }
      const screenshotDimensions = readJpegDimensions(data);
      if (!screenshotDimensions) {
        return this.failCapture();
      }

      return {
        ok: true,
        staged: {
          tabId: this.tabId,
          url,
          title,
          scroll: viewport.scroll,
          dom: rendered.dom,
          refs,
          groundings: rendered.groundings,
          screenshot: { mimeType: "image/jpeg", data, ...screenshotDimensions },
          documentEpoch: identityBefore.documentEpoch,
          navigationEpoch: identityBefore.navigationEpoch,
          graphVersion: graphVersionBefore,
          connectionGeneration: this.connectionGeneration,
        },
      };
    } catch {
      return this.failCapture();
    }
  }

  commitObservation(staged: StagedObservation): ObserveResult {
    const tracker = this.identityTracker;
    if (
      !this.attached ||
      !this.puppeteerPage ||
      !tracker ||
      staged.tabId !== this.tabId ||
      staged.connectionGeneration !== this.connectionGeneration
    ) {
      return this.failCapture();
    }
    if (tracker.version !== staged.graphVersion || !lineagesMatchLive(staged.groundings, tracker)) {
      return this.failCapture();
    }
    const live = tracker.identity;
    if (live.documentEpoch !== staged.documentEpoch || live.navigationEpoch !== staged.navigationEpoch) {
      return this.failCapture();
    }
    const committed = this.snapshots.commit({
      tabId: this.tabId,
      documentEpoch: staged.documentEpoch,
      navigationEpoch: staged.navigationEpoch,
      dom: staged.dom,
      refs: staged.refs,
      groundings: staged.groundings,
    });
    if (!committed.ok) {
      return this.failCapture();
    }
    const identity = committed.snapshot.identity;
    return {
      ok: true,
      state: {
        tabId: this.tabId,
        url: staged.url,
        title: staged.title,
        scroll: staged.scroll,
        dom: staged.dom,
        refs: staged.refs,
        screenshot: staged.screenshot,
        snapshotId: identity.snapshotId,
        snapshotVersion: identity.snapshotVersion,
        documentEpoch: identity.documentEpoch,
        navigationEpoch: identity.navigationEpoch,
      },
    };
  }

  async resolveTarget(target: GroundedTarget): Promise<TargetResolutionResult> {
    if (
      target.tabId !== this.tabId ||
      !this.attached ||
      !this.puppeteerPage ||
      !this.identityTracker ||
      !this.session
    ) {
      return { ok: false, code: "stale_ref", target, reason: "No selected live connection" };
    }
    return resolveTarget(
      { page: this.puppeteerPage, session: this.session, tracker: this.identityTracker },
      this.snapshots,
      target,
    );
  }

  invalidateTargets(): void {
    this.snapshots.invalidate(this.tabId);
  }

  private async extractFrameTree(): Promise<{ content: ExtractedPageContent; overlays: FrameOverlay[] } | null> {
    const page = this.puppeteerPage;
    const tracker = this.identityTracker;
    const session = this.session;
    if (!page || !tracker || !session) {
      return null;
    }
    const binding = await bindFrameGraph(page, tracker, session);
    if (!binding.ok) {
      return null;
    }
    const frameById = new Map<string, Frame>();
    for (const [frame, frameId] of binding.frameIds) {
      frameById.set(frameId, frame);
    }
    const result = await extractFrameRecursive(
      page.mainFrame(),
      binding.frameIds,
      frameById,
      1,
    );
    if (!result) {
      return null;
    }
    const mainRecord = tracker.record(tracker.mainFrameId);
    if (!mainRecord) {
      return null;
    }
    annotateLineages(result.content.root, [toLineageStep(mainRecord)], (frameId) => {
      const record = tracker.record(frameId);
      return record ? toLineageStep(record) : null;
    });
    assignMainViewportBounds(result.content.root, result.content.viewport);
    return { content: result.content, overlays: result.overlays };
  }

  private failCapture(): { ok: false; error: BrowserError } {
    this.snapshots.invalidate(this.tabId);
    return { ok: false, error: { code: "observation_failed", message: "Page observation failed" } };
  }

  private navOptions() {
    return { timeout: this.deps.timeoutMs, waitUntil: "load" as const };
  }

  // Arms click evidence before ElementHandle.click() fires: an opener-matched
  // popup detector and, when a settle context exists, the navigation/DOM/
  // layout machinery behind the bounded barrier. finish cleans up every armed
  // piece on all paths; capture runs once, after the click resolves.
  private prepareActivation(settle?: ActionSettleContext): {
    capture: () => Promise<ClickCapture | null>;
    finish: () => void;
  } {
    const detector = registerNewTabDetector(this.tabId, (listener) => {
      const stop = this.deps.onCreated?.(listener);
      return stop ?? (() => {});
    });
    if (!settle || !this.attached || !this.puppeteerPage || !this.identityTracker) {
      let finished = false;
      return {
        capture: async () => {
          finished = true;
          detector.stop();
          return { ok: true, newTabId: detector.observedTabId(), measurement: {} };
        },
        finish: () => {
          if (!finished) {
            finished = true;
            detector.stop();
          }
        },
      };
    }

    const page = this.puppeteerPage;
    const tracker = this.identityTracker;
    const timings = resolveSettleTimings(this.deps.settleTimings);
    const capMs = settle.timeoutMs ?? this.deps.timeoutMs;
    let finished = false;
    let captured = false;
    const navWatcherPromise = NavigationWatcher.arm(page, tracker, timings);
    const layoutWatcher = new LayoutStabilityWatcher(page, timings);

    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      detector.stop();
      void navWatcherPromise
        .then((watcher) => watcher.dispose())
        .catch(() => {});
    };

    const capture = async (): Promise<ClickCapture | null> => {
      if (captured || finished) {
        return null;
      }
      captured = true;
      try {
        const navWatcher = await navWatcherPromise;
        const startedAt = Date.now();
        const left = (): number => Math.max(0, capMs - (Date.now() - startedAt));
        // All evidence collectors run against the same overall budget, so a
        // click that never navigates still finishes on its stability evidence
        // instead of burning the whole cap waiting for a commit.
        void navWatcher.waitForCommit({ acceptsSameDocument: true }, capMs, settle.signal);
        const measurement: ClickMeasurement = {};

        if (settle.expectation) {
          measurement.expectation = await this.waitForExpectation(
            page,
            settle.expectation,
            left(),
            settle.signal,
            timings.pollMs,
          );
        } else {
          const [signals, layout] = await Promise.all([
            navWatcher.waitForQuiet(left(), settle.signal),
            layoutWatcher.waitForStable(left(), settle.signal),
          ]);
          measurement.signals = signals;
          measurement.layout = layout;
        }

        // Outcome follows the strongest recorded hop regardless of which
        // collector finished first.
        const commits = boundedCommits(navWatcher.allCommits());
        if (commits.length > 0) {
          measurement.commits = commits;
          measurement.outcome = commits.some((record) => record.kind === "main_commit")
            ? "navigation"
            : "same_document";
        } else {
          measurement.outcome = "dom_update";
        }

        const finalUrl = page.url();
        const redirect = redirectPolicyError(finalUrl);
        if (redirect) {
          this.snapshots.invalidate(this.tabId);
          return { ok: false, error: redirect };
        }
        return { ok: true, newTabId: detector.observedTabId(), measurement, finalUrl };
      } finally {
        finish();
      }
    };

    return { capture, finish };
  }

  // Polls role/name counts across live frames until the expectation is
  // exactly satisfied or the budget ends. The pure probe loop lives in
  // waits/expectation.ts; page-level failures inside it are handled there.
  private async waitForExpectation(
    page: Page,
    expected: ActionExpectationPolicy,
    budgetMs: number,
    signal: AbortSignal | undefined,
    pollMs: number,
  ): Promise<ExpectationSignal> {
    return waitForExpectationSignal(page, expected, budgetMs, signal, pollMs);
  }

  // Runs one navigation against armed watchers: commit signals stream from
  // the frame tracker, requests are tracked before the Puppeteer call, and
  // completion needs the expected commit, an allowed final URL, and quiet
  // conditions. One overall budget covers dispatch plus settling; an expired
  // budget after a successful call reports uncertain state instead of
  // failure, and cancellation mid-barrier reports action_cancelled.
  private async runNavigation(
    run: (page: Page) => Promise<unknown>,
    expected: CommitExpectation,
    settle?: ActionSettleContext,
  ): Promise<NavResult> {
    if (!this.attached || !this.puppeteerPage || !this.identityTracker) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    this.snapshots.invalidate(this.tabId);

    const page = this.puppeteerPage;
    const watcher = await NavigationWatcher.arm(page, this.identityTracker, resolveSettleTimings(this.deps.settleTimings));
    const capMs = settle?.timeoutMs ?? this.deps.timeoutMs;
    const signal = settle?.signal;
    const startedAt = Date.now();
    const left = (): number => Math.max(0, capMs - (Date.now() - startedAt));
    const cancelError = (): NavResult => ({
      ok: false,
      error: {
        code: "action_cancelled",
        message: "Browser action was cancelled during dispatch",
        dispatchStarted: true,
      },
    });
    try {
      try {
        await run(page);
      } catch (error) {
        this.detachIfDisconnected();
        if (error instanceof Error && error.name === "TimeoutError") {
          return { ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } };
        }
        return { ok: false, error: { code: "navigation_failed", message: "Navigation failed" } };
      }

      const commit = await watcher.waitForCommit(expected, left(), signal);
      if (commit.status === "cancelled") {
        return cancelError();
      }
      if (commit.status === "timeout") {
        // The Puppeteer call succeeded but no commit proved where the page
        // landed, so the old refs stay stale and the outcome is uncertainty,
        // not failure.
        return { ok: true, url: boundText(page.url()), timedOut: true };
      }

      // Hops may land during the quiet window, so the final URL and its
      // policy verdict are read after settling.
      const signals = await watcher.waitForQuiet(left(), signal);
      if (signal?.aborted) {
        return cancelError();
      }
      const finalUrl = boundText(page.url());
      const redirect = redirectPolicyError(finalUrl);
      if (redirect) {
        this.snapshots.invalidate(this.tabId);
        return { ok: false, error: redirect };
      }

      return {
        ok: true,
        url: finalUrl,
        commitType: commit.match.kind === "same_document" ? "same_document" : "commit",
        documentEpoch: commit.match.documentEpoch,
        navigationEpoch: commit.match.navigationEpoch,
        commits: boundedCommits(watcher.allCommits()),
        signals,
      };
    } finally {
      watcher.dispose();
    }
  }

  private detachIfDisconnected(): void {
    if (this.browser && !this.browser.connected) {
      this.connectionGeneration += 1;
      this.browser = null;
      this.puppeteerPage = null;
      this.session = null;
      this.identityTracker?.dispose();
      this.identityTracker = null;
      this.snapshots.invalidate(this.tabId);
      try {
        this.deps.onConnectionReplaced?.(this.tabId);
      } catch {
        // Teardown notifications must never mask the action's own result.
      }
    }
  }
}

async function extractFrameRecursive(
  frame: Frame,
  frameIds: Map<Frame, string>,
  frameById: Map<string, Frame>,
  startRef: number,
): Promise<ExtractedFrameTreeResult | null> {
  const owners: OwnerMap = {};
  for (const child of frame.childFrames()) {
    const childId = frameIds.get(child);
    if (!childId) {
      return null;
    }
    const owner = await child.frameElement();
    if (!owner) {
      return null;
    }
    try {
      const path = await owner.evaluate(pathOfElement);
      if (path === null) {
        return null;
      }
      owners[JSON.stringify(path)] = childId;
    } catch {
      return null;
    } finally {
      await owner.dispose();
    }
  }

  let raw: ExtractedFrameContent;
  try {
    raw = (await frame.evaluate(observePageExpression(startRef, owners))) as ExtractedFrameContent;
  } catch {
    return null;
  }

  const content = await enrichPageContentWithAccessibility(raw.content, async (control) => {
    const handle = await frame.evaluateHandle(resolveElementAtPath, control.domPath);
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      return null;
    }
    try {
      const tag = await element.evaluate((node) =>
        node instanceof Element ? node.tagName.toLowerCase() : null,
      );
      if (tag !== control.tag) {
        return null;
      }
      control.backendNodeId = await element.backendNodeId();
      return await frame.accessibility.snapshot({ root: element, interestingOnly: false });
    } finally {
      await handle.dispose();
    }
  });

  const overlays: FrameOverlay[] = [
    {
      frame,
      refs: content.controls.filter((control) => control.ref !== null).map(toObservedRef),
      viewport: content.viewport,
    },
  ];

  let nextRef = raw.nextRef;
  for (const placeholder of collectFrameNodes(content.root)) {
    if (!placeholder.frameId) {
      return null;
    }
    const childFrame = frameById.get(placeholder.frameId);
    if (!childFrame) {
      return null;
    }
    const childResult = await extractFrameRecursive(
      childFrame,
      frameIds,
      frameById,
      nextRef,
    );
    if (!childResult) {
      return null;
    }

    const owner = await childFrame.frameElement();
    if (!owner) {
      return null;
    }
    let ownerGeometry: FrameOwnerGeometry | null;
    try {
      ownerGeometry = await owner.evaluate(measureFrameOwner);
    } catch {
      return null;
    } finally {
      await owner.dispose();
    }
    if (!ownerGeometry) {
      return null;
    }
    translateToParentViewport(childResult.content.root, ownerGeometry, content.viewport);

    placeholder.children = childResult.content.root.children;
    nextRef = childResult.nextRef;
    overlays.push(...childResult.overlays);
  }

  return { content, nextRef, overlays };
}

function translateToParentViewport(
  root: ExtractedNode,
  ownerGeometry: FrameOwnerGeometry,
  parentViewport: ViewportMeasurements,
): void {
  const visibleOwner = clipToRect(
    ownerGeometry.contentRect,
    { x: 0, y: 0, width: parentViewport.width, height: parentViewport.height },
  );
  const walk = (node: ExtractedNode): void => {
    if (node.kind === "element") {
      if (node.ref !== null) {
        node.viewportBounds = translateBounds(
          node.viewportBounds === undefined ? node.bounds : node.viewportBounds,
          ownerGeometry,
          visibleOwner,
        );
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.kind === "frame" || node.kind === "shadow") {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

function translateBounds(
  bounds: RectBounds | null,
  ownerGeometry: FrameOwnerGeometry,
  visibleOwner: RectBounds | null,
): RectBounds | null {
  if (bounds === null || visibleOwner === null) {
    return null;
  }
  return clipToRect(
    {
      x: Math.round(ownerGeometry.contentRect.x + bounds.x * ownerGeometry.scaleX),
      y: Math.round(ownerGeometry.contentRect.y + bounds.y * ownerGeometry.scaleY),
      width: Math.round(bounds.width * ownerGeometry.scaleX),
      height: Math.round(bounds.height * ownerGeometry.scaleY),
    },
    visibleOwner,
  );
}

function measureFrameOwner(element: HTMLIFrameElement): FrameOwnerGeometry | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const layoutWidth = element.offsetWidth > 0 ? element.offsetWidth : rect.width;
  const layoutHeight = element.offsetHeight > 0 ? element.offsetHeight : rect.height;
  const scaleX = rect.width / layoutWidth;
  const scaleY = rect.height / layoutHeight;
  const clientWidth = element.clientWidth > 0 ? element.clientWidth : layoutWidth;
  const clientHeight = element.clientHeight > 0 ? element.clientHeight : layoutHeight;
  const contentX = rect.x + element.clientLeft * scaleX;
  const contentY = rect.y + element.clientTop * scaleY;
  return {
    contentRect: {
      x: Math.round(contentX),
      y: Math.round(contentY),
      width: Math.round(clientWidth * scaleX),
      height: Math.round(clientHeight * scaleY),
    },
    scaleX,
    scaleY,
  };
}

function assignMainViewportBounds(root: ExtractedNode, viewport: ViewportMeasurements): void {
  const mainRect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const walk = (node: ExtractedNode): void => {
    if (node.kind === "element") {
      if (node.ref !== null && node.viewportBounds === undefined && node.bounds !== null) {
        node.viewportBounds = clipToRect(node.bounds, mainRect);
      }
      for (const child of node.children) {
        walk(child);
      }
      return;
    }
    if (node.kind === "frame" || node.kind === "shadow") {
      for (const child of node.children) {
        walk(child);
      }
    }
  };
  walk(root);
}

function lineagesMatchLive(groundings: GroundingRecord[], tracker: FrameGraphTracker): boolean {
  for (const grounding of groundings) {
    for (const step of grounding.frameLineage) {
      if (!lineageStepMatchesLive(step, tracker.record(step.frameId))) {
        return false;
      }
    }
  }
  return true;
}

function collectFrameNodes(root: ExtractedNode, out: ExtractedFrame[] = []): ExtractedFrame[] {
  if (root.kind === "frame") {
    out.push(root);
    return out;
  }
  if (root.kind === "element" || root.kind === "shadow") {
    for (const child of root.children) {
      collectFrameNodes(child, out);
    }
  }
  return out;
}

function annotateLineages(
  node: ExtractedNode,
  lineage: FrameLineageStep[],
  stepFor: (frameId: string) => FrameLineageStep | null,
): void {
  if (node.kind === "element") {
    node.frameLineage = lineage;
    for (const child of node.children) {
      annotateLineages(child, lineage, stepFor);
    }
    return;
  }
  if (node.kind === "frame") {
    if (!node.frameId) {
      return;
    }
    const step = stepFor(node.frameId);
    if (!step) {
      return;
    }
    const childLineage = [...lineage, step];
    for (const child of node.children) {
      annotateLineages(child, childLineage, stepFor);
    }
    return;
  }
  if (node.kind === "shadow") {
    for (const child of node.children) {
      annotateLineages(child, lineage, stepFor);
    }
  }
}

function toLineageStep(record: FrameRecord): FrameLineageStep {
  return {
    frameId: record.frameId,
    parentFrameId: record.parentFrameId,
    documentEpoch: record.documentEpoch,
    navigationEpoch: record.navigationEpoch,
  };
}

function resolveElementAtPath(path: PathStep[]): Element | null {
  let node: Node | null = document.body;
  for (const step of path) {
    if (step.kind === "shadow") {
      node = node instanceof Element ? node.shadowRoot : null;
    } else {
      node = node?.childNodes.item(step.index) ?? null;
    }
  }
  return node instanceof Element ? node : null;
}

function pathOfElement(el: Element): PathStep[] | null {
  const reversed: PathStep[] = [];
  let node: Node | null = el;
  const root = document.body;
  while (node && node !== root) {
    const parent: Node | null = node.parentNode;
    if (!parent) {
      return null;
    }
    const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
    if (index < 0) {
      return null;
    }
    reversed.push({ kind: "child", index });
    if (parent.nodeType === 11) {
      reversed.push({ kind: "shadow" });
      node = (parent as ShadowRoot).host;
    } else {
      node = parent;
    }
  }
  return node ? reversed.reverse() : null;
}

export const defaultPageDeps: PageDeps = {
  connect,
  connectTab: (tabId) => ExtensionTransport.connectTab(tabId),
  timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
  onCreated: (listener) => {
    chrome.tabs.onCreated.addListener(listener);
    return () => chrome.tabs.onCreated.removeListener(listener);
  },
};
