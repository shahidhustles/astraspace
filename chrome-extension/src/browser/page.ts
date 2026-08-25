import {
  connect,
  ExtensionTransport,
  type Browser,
  type Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { enforceUrlPolicy } from "./url-policy";
import type { BrowserError, UrlPolicyResult } from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 10_000;

export interface PageDeps {
  connect: (options: Parameters<typeof connect>[0]) => Promise<Browser>;
  connectTab: (tabId: number) => Promise<ExtensionTransport>;
  timeoutMs: number;
}

export type AttachResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

export type NavResult = { ok: true; url: string } | { ok: false; error: BrowserError };

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

  async disconnect(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.puppeteerPage = null;
    if (browser) {
      await browser.disconnect();
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