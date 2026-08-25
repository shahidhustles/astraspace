import {
  connect,
  ExtensionTransport,
  type Browser,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import {
  buildHighlightOverlayExpression,
  enrichPageContentWithAccessibility,
  observePageExpression,
  removeHighlightOverlayExpression,
  renderPageContent,
  type ExtractedPageContent,
} from "./observation";
import { enforceUrlPolicy } from "./url-policy";
import type { BrowserError, ObserveResult, UrlPolicyResult } from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;
const SCREENSHOT_QUALITY = 85;

export interface PageDeps {
  connect: (options: Parameters<typeof connect>[0]) => Promise<Browser>;
  connectTab: (tabId: number) => Promise<ExtensionTransport>;
  timeoutMs: number;
}

export type AttachResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

export type NavResult = { ok: true; url: string } | { ok: false; error: BrowserError };

export type DisconnectResult = { ok: true } | { ok: false; error: BrowserError };

export class BrowserPage {
  readonly tabId: number;
  readonly url: string;

  private readonly deps: PageDeps;
  private readonly policy: UrlPolicyResult;
  private browser: Browser | null = null;
  private puppeteerPage: Page | null = null;

  constructor(tabId: number, url: string, deps: PageDeps = defaultDeps) {
    this.tabId = tabId;
    this.url = url;
    this.deps = deps;
    this.policy = enforceUrlPolicy(url);
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
      this.browser = browser;
      this.puppeteerPage = page;
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

  async observe(): Promise<ObserveResult> {
    if (!this.attached || !this.puppeteerPage) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    if (!this.policy.ok) {
      return { ok: false, error: this.policy.error };
    }
    const page = this.puppeteerPage;
    const url = page.url();
    const currentPolicy = enforceUrlPolicy(url);
    if (!currentPolicy.ok) {
      return { ok: false, error: currentPolicy.error };
    }

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

      await page.evaluate(buildHighlightOverlayExpression(refs, viewport));
      let data: string;
      try {
        data = (await page.screenshot({
          type: "jpeg",
          quality: SCREENSHOT_QUALITY,
          encoding: "base64",
        })) as string;
      } finally {
        await page.evaluate(removeHighlightOverlayExpression());
      }

      return {
        ok: true,
        state: {
          tabId: this.tabId,
          url,
          title,
          scroll: viewport.scroll,
          dom: rendered.dom,
          refs,
          screenshot: { mimeType: "image/jpeg", data, width: viewport.width, height: viewport.height },
        },
      };
    } catch {
      return { ok: false, error: { code: "observation_failed", message: "Page observation failed" } };
    }
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
    }
  }
}

const defaultDeps: PageDeps = {
  connect,
  connectTab: (tabId) => ExtensionTransport.connectTab(tabId),
  timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
};
