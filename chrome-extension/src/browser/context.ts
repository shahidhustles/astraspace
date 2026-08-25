import { enforceUrlPolicy } from "./url-policy";
import { BrowserPage, type AttachResult, type NavResult, type PageDeps } from "./page";
import type { BrowserError, DiagnosticEvent, TabInfo } from "./types";

export type TabListResult = { ok: true; tabs: TabInfo[] } | { ok: false; error: BrowserError };

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ContextDeps {
  queryActiveTab: () => Promise<chrome.tabs.Tab[]>;
  queryTabs: () => Promise<chrome.tabs.Tab[]>;
  createTab: (url: string) => Promise<chrome.tabs.Tab>;
  updateTab: (tabId: number) => Promise<chrome.tabs.Tab | undefined>;
  onUpdated: (
    listener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
  ) => () => void;
  onActivated: (listener: (info: chrome.tabs.OnActivatedInfo) => void) => () => void;
  diagnostics: (event: DiagnosticEvent) => void;
  pageDeps?: PageDeps;
  timeoutMs: number;
}

interface WaitHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}

export class BrowserContext {
  private readonly pages = new Map<number, BrowserPage>();
  private readonly pending = new Map<number, Promise<AttachResult>>();
  private readonly deps: ContextDeps;
  private selectedTab: number | null = null;

  constructor(deps: Partial<ContextDeps> = {}) {
    this.deps = {
      queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }),
      queryTabs: () => chrome.tabs.query({}),
      createTab: (url) => chrome.tabs.create({ url, active: true }),
      updateTab: (tabId) => chrome.tabs.update(tabId, { active: true }),
      onUpdated: (listener) => {
        chrome.tabs.onUpdated.addListener(listener);
        return () => chrome.tabs.onUpdated.removeListener(listener);
      },
      onActivated: (listener) => {
        chrome.tabs.onActivated.addListener(listener);
        return () => chrome.tabs.onActivated.removeListener(listener);
      },
      diagnostics: () => {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
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

  async listTabs(): Promise<TabListResult> {
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await this.deps.queryTabs();
    } catch {
      return { ok: false, error: { code: "chrome_api_error", message: "Could not query tabs" } };
    }

    const listed: TabInfo[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined || tab.url === undefined) {
        continue;
      }
      if (!enforceUrlPolicy(tab.url).ok) {
        continue;
      }
      const page = this.pages.get(tab.id);
      listed.push({
        tabId: tab.id,
        url: tab.url,
        title: tab.title ?? "",
        attached: page?.attached ?? false,
        selected: tab.id === this.selectedTab,
      });
    }
    return { ok: true, tabs: listed };
  }

  async openTab(url: string): Promise<AttachResult> {
    const policy = enforceUrlPolicy(url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }

    let created: chrome.tabs.Tab;
    try {
      created = await this.deps.createTab(url);
    } catch {
      return { ok: false, error: { code: "chrome_api_error", message: "Could not create tab" } };
    }
    if (created.id === undefined || created.url === undefined) {
      return { ok: false, error: { code: "chrome_api_error", message: "Created tab has no id or URL" } };
    }

    let reached: chrome.tabs.Tab;
    try {
      const handle = this.waitFor<{ tabId: number; tab: chrome.tabs.Tab }>(
        (cb) => this.deps.onUpdated((tabId, _changeInfo, tab) => cb({ tabId, tab })),
        (value) =>
          value.tabId === created.id &&
          value.tab.url !== undefined &&
          enforceUrlPolicy(value.tab.url).ok,
      );
      reached = (await handle.promise).tab;
    } catch {
      return { ok: false, error: { code: "lifecycle_timeout", message: "Tab did not reach a controllable URL" } };
    }

    if (reached.url === undefined) {
      return { ok: false, error: { code: "chrome_api_error", message: "Created tab has no URL" } };
    }
    return this.attachTab(created.id, reached.url);
  }

  async switchTab(tabId: number): Promise<AttachResult> {
    const handle = this.waitFor<chrome.tabs.OnActivatedInfo>(
      (cb) => this.deps.onActivated((info) => cb(info)),
      (info) => info.tabId === tabId,
    );

    let tab: chrome.tabs.Tab;
    try {
      const updated = await this.deps.updateTab(tabId);
      if (!updated) {
        handle.cancel();
        return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
      }
      tab = updated;
    } catch {
      handle.cancel();
      return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
    }

    try {
      await handle.promise;
    } catch {
      return { ok: false, error: { code: "lifecycle_timeout", message: "Tab did not activate" } };
    }

    const existing = this.pages.get(tabId);
    if (existing) {
      if (existing.attached) {
        this.selectedTab = tabId;
        this.deps.diagnostics({ type: "attach_reused", tabId });
        return { ok: true, tabId };
      }
      return this.runAttach(existing);
    }

    if (tab.url === undefined) {
      return { ok: false, error: { code: "inaccessible_tab", message: "Tab URL is not exposed" } };
    }
    const policy = enforceUrlPolicy(tab.url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }
    return this.attachTab(tabId, tab.url);
  }

  async navigate(url: string): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.navigate(url);
  }

  async goBack(): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.goBack();
  }

  async refresh(): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.reload();
  }

  private selectedPage(): BrowserPage | null {
    if (this.selectedTab === null) {
      return null;
    }
    const page = this.pages.get(this.selectedTab);
    if (!page || !page.attached) {
      return null;
    }
    return page;
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

  private waitFor<T>(
    subscribe: (cb: (value: T) => void) => () => void,
    predicate: (value: T) => boolean,
  ): WaitHandle<T> {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const promise = new Promise<T>((resolve, reject) => {
      unsubscribe = subscribe((value) => {
        if (settled) {
          return;
        }
        if (predicate(value)) {
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          unsubscribe?.();
          resolve(value);
        }
      });
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribe?.();
        reject(new Error(`Timed out after ${this.deps.timeoutMs}ms`));
      }, this.deps.timeoutMs);
    });

    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        unsubscribe?.();
      },
    };
  }
}