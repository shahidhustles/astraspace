import {
  connect,
  ExtensionTransport,
  type Browser,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { MainFrameIdentityTracker } from "./document-identity";
import {
  buildHighlightOverlayExpression,
  enrichPageContentWithAccessibility,
  observePageExpression,
  readJpegDimensions,
  removeHighlightOverlayExpression,
  renderPageContent,
  type ExtractedPageContent,
  type GroundingRecord,
  type ObservedRef,
  type ScrollState,
  type ViewportCapture,
} from "./observation";
import { SnapshotStore } from "./snapshot";
import { enforceUrlPolicy } from "./url-policy";
import type { BrowserError, ObserveResult, UrlPolicyResult } from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const SCREENSHOT_QUALITY = 85;

export interface PageDeps {
  connect: (options: Parameters<typeof connect>[0]) => Promise<Browser>;
  connectTab: (tabId: number) => Promise<ExtensionTransport>;
  timeoutMs: number;
  snapshotStore?: SnapshotStore;
}

export type AttachResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

export type NavResult = { ok: true; url: string } | { ok: false; error: BrowserError };

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
}

export type StageResult = { ok: true; staged: StagedObservation } | { ok: false; error: BrowserError };

export class BrowserPage {
  readonly tabId: number;
  readonly url: string;

  private readonly deps: PageDeps;
  private readonly policy: UrlPolicyResult;
  private readonly snapshots: SnapshotStore;
  private browser: Browser | null = null;
  private puppeteerPage: Page | null = null;
  private identityTracker: MainFrameIdentityTracker | null = null;
  private observationQueue: Promise<void> = Promise.resolve();

  constructor(tabId: number, url: string, deps: PageDeps = defaultDeps) {
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
      const session = await page.createCDPSession();
      const identityTracker = await MainFrameIdentityTracker.create(session);
      this.browser = browser;
      this.puppeteerPage = page;
      this.identityTracker = identityTracker;
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
    this.browser = null;
    this.puppeteerPage = null;
    this.identityTracker?.dispose();
    this.identityTracker = null;
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

  async navigate(url: string): Promise<NavResult> {
    const policy = enforceUrlPolicy(url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }
    return this.runNavigation((page) => page.goto(url, this.navOptions()));
  }

  async goBack(): Promise<NavResult> {
    return this.runNavigation((page) => page.goBack(this.navOptions()));
  }

  async reload(): Promise<NavResult> {
    return this.runNavigation((page) => page.reload(this.navOptions()));
  }

  observe(): Promise<ObserveResult> {
    const result = this.observationQueue.then(() => this.performObservation());
    this.observationQueue = result.then(
      () => {},
      () => {},
    );
    return result;
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
      return { ok: false, error: currentPolicy.error };
    }
    const identityBefore = tracker.identity;

    try {
      const title = await page.title();
      const content = (await page.evaluate(observePageExpression())) as ExtractedPageContent;
      const enriched = await enrichPageContentWithAccessibility(content, async (control) => {
        const handle = await page.evaluateHandle((domPath: number[]) => {
          let node: Node | null = document.body;
          for (const index of domPath) {
            node = node?.childNodes.item(index) ?? null;
          }
          return node instanceof Element ? node : null;
        }, control.domPath);
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
          return await page.accessibility.snapshot({ root: element, interestingOnly: false });
        } finally {
          await handle.dispose();
        }
      });
      const rendered = renderPageContent(enriched);
      const refs = rendered.refs;
      const viewport = enriched.viewport;
      const captureId = crypto.randomUUID();

      let data: string;
      try {
        await page.evaluate(buildHighlightOverlayExpression(refs, viewport, captureId));
        data = (await page.screenshot({
          type: "jpeg",
          quality: SCREENSHOT_QUALITY,
          encoding: "base64",
        })) as string;
      } finally {
        await page.evaluate(removeHighlightOverlayExpression(captureId));
      }

      const finalUrl = page.url();
      if (finalUrl !== url || !enforceUrlPolicy(finalUrl).ok) {
        return this.failCapture();
      }
      const identityAfter = tracker.identity;
      if (
        identityAfter.documentEpoch !== identityBefore.documentEpoch ||
        identityAfter.navigationEpoch !== identityBefore.navigationEpoch
      ) {
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
        },
      };
    } catch {
      return this.failCapture();
    }
  }

  commitObservation(staged: StagedObservation): ObserveResult {
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

  private failCapture(): { ok: false; error: BrowserError } {
    this.snapshots.invalidate(this.tabId);
    return { ok: false, error: { code: "observation_failed", message: "Page observation failed" } };
  }

  private navOptions() {
    return { timeout: this.deps.timeoutMs, waitUntil: "load" as const };
  }

  private async runNavigation(run: (page: Page) => Promise<unknown>): Promise<NavResult> {
    if (!this.attached || !this.puppeteerPage) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }

    const page = this.puppeteerPage;
    try {
      await run(page);
    } catch (error) {
      this.detachIfDisconnected();
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, error: { code: "navigation_timeout", message: "Navigation timed out" } };
      }
      return { ok: false, error: { code: "navigation_failed", message: "Navigation failed" } };
    }

    const finalUrl = page.url();
    const policy = enforceUrlPolicy(finalUrl);
    if (!policy.ok) {
      return {
        ok: false,
        error: { code: "unsupported_redirect", message: "Navigation ended on an unsupported page", url: finalUrl },
      };
    }
    return { ok: true, url: finalUrl };
  }

  private detachIfDisconnected(): void {
    if (this.browser && !this.browser.connected) {
      this.browser = null;
      this.puppeteerPage = null;
      this.identityTracker?.dispose();
      this.identityTracker = null;
    }
  }
}

const defaultDeps: PageDeps = {
  connect,
  connectTab: (tabId) => ExtensionTransport.connectTab(tabId),
  timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
};
