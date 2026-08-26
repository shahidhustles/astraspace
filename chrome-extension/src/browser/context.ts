import { enforceUrlPolicy } from "./url-policy";
import { BrowserPage, type AttachResult, type NavResult, type PageDeps } from "./page";
import type {
  ClearInputResult,
  ClickResult,
  KeypressInput,
  KeypressResult,
  ScrollInput,
  ScrollResult,
  TypeResult,
} from "./actions/types";
import type { BrowserError, DiagnosticEvent, GroundedTarget, ObservationResult, TabInfo } from "./types";

export type TabListResult = { ok: true; tabs: TabInfo[] } | { ok: false; error: BrowserError };

export type CloseResult = { ok: true; tabId: number } | { ok: false; error: BrowserError };

export type CleanupResult = { failures: BrowserError[] };

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ContextDeps {
  queryActiveTab: () => Promise<chrome.tabs.Tab[]>;
  queryTabs: () => Promise<chrome.tabs.Tab[]>;
  createTab: (url: string) => Promise<chrome.tabs.Tab>;
  updateTab: (tabId: number) => Promise<chrome.tabs.Tab | undefined>;
  removeTab: (tabId: number) => Promise<void>;
  onUpdated: (
    listener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void,
  ) => () => void;
  onActivated: (listener: (info: chrome.tabs.OnActivatedInfo) => void) => () => void;
  onRemoved: (listener: (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void) => () => void;
  onDetach: (listener: (source: chrome.debugger.Debuggee, reason: string) => void) => () => void;
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
  private readonly stopListeners: (() => void)[] = [];
  private selectedTab: number | null = null;
  private observeQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: Partial<ContextDeps> = {}) {
    this.deps = {
      queryActiveTab: () => chrome.tabs.query({ active: true, currentWindow: true }),
      queryTabs: () => chrome.tabs.query({}),
      createTab: (url) => chrome.tabs.create({ url, active: true }),
      updateTab: (tabId) => chrome.tabs.update(tabId, { active: true }),
      removeTab: (tabId) => chrome.tabs.remove(tabId),
      onUpdated: (listener) => {
        chrome.tabs.onUpdated.addListener(listener);
        return () => chrome.tabs.onUpdated.removeListener(listener);
      },
      onActivated: (listener) => {
        chrome.tabs.onActivated.addListener(listener);
        return () => chrome.tabs.onActivated.removeListener(listener);
      },
      onRemoved: (listener) => {
        chrome.tabs.onRemoved.addListener(listener);
        return () => chrome.tabs.onRemoved.removeListener(listener);
      },
      onDetach: (listener) => {
        chrome.debugger.onDetach.addListener(listener);
        return () => chrome.debugger.onDetach.removeListener(listener);
      },
      diagnostics: () => {},
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...deps,
    };

    this.stopListeners.push(this.deps.onRemoved((tabId) => this.handleTabRemoved(tabId)));
    this.stopListeners.push(this.deps.onDetach((source) => this.handleDebuggerDetach(source)));
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

    const createdPolicy = enforceUrlPolicy(created.url);
    if (createdPolicy.ok) {
      return this.attachTab(created.id, createdPolicy.url);
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

  async observe(): Promise<ObservationResult> {
    const result = this.observeQueue.then(() => this.performObserve());
    this.observeQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async performObserve(): Promise<ObservationResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }

    const staged = await page.stageObservation();
    if (!staged.ok) {
      return staged;
    }

    const tabsResult = await this.listTabs();
    if (!tabsResult.ok) {
      page.invalidateTargets();
      return {
        ok: false,
        error: { code: "observation_failed", message: "Browser observation failed" },
      };
    }

    if (this.selectedPage() !== page) {
      page.invalidateTargets();
      return {
        ok: false,
        error: { code: "observation_failed", message: "Browser observation failed" },
      };
    }

    const committed = page.commitObservation(staged.staged);
    if (!committed.ok) {
      return committed;
    }

    return { ok: true, state: { ...committed.state, tabs: tabsResult.tabs } };
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

  async click(target: GroundedTarget): Promise<ClickResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.click(target);
  }

  async type(target: GroundedTarget, text: string): Promise<TypeResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.type(target, text);
  }

  async clearInput(target: GroundedTarget): Promise<ClearInputResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.clearInput(target);
  }

  async keypress(input: KeypressInput): Promise<KeypressResult> {
    if (input.target) {
      const page = this.pages.get(input.target.tabId);
      if (!page) {
        return {
          ok: false,
          error: { code: "stale_ref", message: "No page connection for this tab", target: input.target },
        };
      }
      return page.keypress(input);
    }
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.keypress(input);
  }

  async scroll(input: ScrollInput): Promise<ScrollResult> {
    if (input.target) {
      const page = this.pages.get(input.target.tabId);
      if (!page) {
        return {
          ok: false,
          error: { code: "stale_ref", message: "No page connection for this tab", target: input.target },
        };
      }
      return page.scroll(input);
    }
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.scroll(input);
  }

  async scrollToText(text: string, occurrence: number): Promise<ScrollResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.scrollToText(text, occurrence);
  }

  async closeTab(tabId: number): Promise<CloseResult> {
    const page = this.pages.get(tabId);
    if (!page) {
      return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
    }

    try {
      await this.deps.removeTab(tabId);
    } catch (error) {
      if (error instanceof Error && /no tab with id/i.test(error.message)) {
        return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
      }
      return { ok: false, error: { code: "chrome_api_error", message: "Could not close tab" } };
    }

    const disconnected = await page.disconnect();
    this.removeTabRecord(tabId);
    if (!disconnected.ok) {
      return { ok: false, error: disconnected.error };
    }
    return { ok: true, tabId };
  }

  async cleanup(): Promise<CleanupResult> {
    const failures: BrowserError[] = [];
    for (const page of this.pages.values()) {
      const result = await page.disconnect();
      if (!result.ok) {
        failures.push(result.error);
      }
    }
    for (const stop of this.stopListeners.splice(0)) {
      stop();
    }
    this.pages.clear();
    this.pending.clear();
    this.selectedTab = null;
    return { failures };
  }

  private handleTabRemoved(tabId: number): void {
    this.discardPage(tabId);
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
    if (source.tabId !== undefined) {
      this.discardPage(source.tabId);
    }
  }

  private discardPage(tabId: number): void {
    const page = this.pages.get(tabId);
    this.removeTabRecord(tabId);
    if (page) {
      void page.disconnect();
    }
  }

  private removeTabRecord(tabId: number): void {
    this.pages.delete(tabId);
    this.pending.delete(tabId);
    if (this.selectedTab === tabId) {
      this.selectedTab = null;
    }
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
