import { BrowserPage, type AttachResult, type PageDeps } from "./page";
import type { DiagnosticEvent } from "./types";

export interface ContextDeps {
  queryActiveTab: () => Promise<chrome.tabs.Tab[]>;
  diagnostics: (event: DiagnosticEvent) => void;
  pageDeps?: PageDeps;
}

export class BrowserContext {
  private readonly pages = new Map<number, BrowserPage>();
  private readonly pending = new Map<number, Promise<AttachResult>>();
  private readonly deps: ContextDeps;
  private selectedTab: number | null = null;

  constructor(deps: Partial<ContextDeps> = {}) {
    this.deps = {
      queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }),
      diagnostics: () => {},
      ...deps,
    };
  }

  get selectedTabId(): number | null {
    return this.selectedTab;
  }

  get tabCount(): number {
    return this.pages.size;
  }

  async useActiveTab(): Promise<AttachResult> {
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await this.deps.queryActiveTab();
    } catch {
      return { ok: false, error: { code: "active_tab_unavailable", message: "Could not query tabs" } };
    }

    const tab = tabs[0];
    if (!tab || tab.id === undefined) {
      return { ok: false, error: { code: "active_tab_unavailable", message: "No controllable active tab" } };
    }
    if (tab.url === undefined) {
      return { ok: false, error: { code: "inaccessible_tab", message: "Active tab URL is not exposed" } };
    }
    return this.attachTab(tab.id, tab.url);
  }

  private attachTab(tabId: number, url: string): Promise<AttachResult> {
    const existing = this.pages.get(tabId);
    if (existing) {
      if (existing.attached) {
        this.selectedTab = tabId;
        this.deps.diagnostics({ type: "attach_reused", tabId });
        return Promise.resolve({ ok: true, tabId });
      }
      return this.runAttach(existing);
    }

    const page = new BrowserPage(tabId, url, this.deps.pageDeps);
    this.pages.set(tabId, page);
    return this.runAttach(page);
  }

  private runAttach(page: BrowserPage): Promise<AttachResult> {
    const inFlight = this.pending.get(page.tabId);
    if (inFlight) {
      return inFlight;
    }

    this.deps.diagnostics({ type: "attach_started", tabId: page.tabId });
    const attempt = page
      .attach()
      .then((result) => {
        if (result.ok) {
          this.selectedTab = page.tabId;
          this.deps.diagnostics({ type: "attach_ok", tabId: page.tabId });
        } else {
          this.deps.diagnostics({ type: "attach_failed", tabId: page.tabId, code: result.error.code });
        }
        return result;
      })
      .finally(() => {
        this.pending.delete(page.tabId);
      });
    this.pending.set(page.tabId, attempt);
    return attempt;
  }
}