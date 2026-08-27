import { enforceUrlPolicy } from "./url-policy";
import { boundText } from "./waits/types";
import { BrowserPage, defaultPageDeps, type AttachResult, type NavResult, type PageDeps } from "./page";
import { enqueueActionRequest } from "./waits/coordinator";
import {
  type BrowserActionCancelReply,
  type BrowserActionRequest,
  type ScheduledAction,
  type ActionCancelledError,
  type ActionWaitTimeoutError,
} from "./actions/types";
import { TabActionCoordinator } from "./waits/coordinator";
import {
  createActionId,
  type ActionId,
  type ActionSettleContext,
  type TabCompletionSource,
  type TabLifecycleMeasurement,
} from "./waits/types";
import type {
  ClearInputResult,
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
import type { BrowserError, DiagnosticEvent, GroundedTarget, ObservationResult, TabInfo } from "./types";

export type TabListResult = { ok: true; tabs: TabInfo[] } | { ok: false; error: BrowserError };

// Success evidence for open, switch, and close actions: the acting tab plus
// how Chrome completed the lifecycle. Close may also end bounded without a
// completed removal, which surfaces as the action-level timeout or cancel.
export type TabLifecycleResult =
  | { ok: true; tabId: number; measured: TabLifecycleMeasurement }
  | { ok: false; error: BrowserError | ActionCancelledError | ActionWaitTimeoutError };

type RemovalCheck =
  | { kind: "removed" }
  | { kind: "missing_tab" }
  | { kind: "chrome_error" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

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
  private readonly actionCoordinator = new TabActionCoordinator();
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

  scheduleAction(input: { request: BrowserActionRequest; tabId: number }): ScheduledAction {
    return enqueueActionRequest(this.actionCoordinator, input.request, input.tabId, this);
  }

  cancelAction(id: ActionId): BrowserActionCancelReply {
    return this.actionCoordinator.cancel(id);
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
        url: boundText(tab.url),
        title: boundText(tab.title ?? ""),
        attached: page?.attached ?? false,
        selected: tab.id === this.selectedTab,
      });
    }
    return { ok: true, tabs: listed };
  }

  async openTab(url: string, settle?: ActionSettleContext): Promise<TabLifecycleResult> {
    const startedAt = Date.now();
    const policy = enforceUrlPolicy(url);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }

    let createdTabId: number | null = null;
    const earlyUpdates = new Map<number, chrome.tabs.Tab>();
    const handle = this.waitFor<{ tabId: number; tab: chrome.tabs.Tab }>(
      (cb) => {
        return this.deps.onUpdated((tabId, _changeInfo, tab) => {
          if (createdTabId === null) {
            earlyUpdates.set(tabId, tab);
            return;
          }
          cb({ tabId, tab });
        });
      },
      (value) =>
        value.tabId === createdTabId &&
        value.tab.url !== undefined &&
        enforceUrlPolicy(value.tab.url).ok,
    );

    let created: chrome.tabs.Tab;
    try {
      created = await this.deps.createTab(url);
    } catch {
      handle.cancel();
      return { ok: false, error: { code: "chrome_api_error", message: "Could not create tab" } };
    }
    if (created.id === undefined || created.url === undefined) {
      handle.cancel();
      return { ok: false, error: { code: "chrome_api_error", message: "Created tab has no id or URL" } };
    }
    const openedId = created.id;
    createdTabId = openedId;

    const createdPolicy = enforceUrlPolicy(created.url);
    if (createdPolicy.ok) {
      handle.cancel();
      return this.completeLifecycle(
        startedAt,
        "controllable_url_and_attach",
        settle,
        () => this.attachTab(openedId, createdPolicy.url),
      );
    }

    let reached: chrome.tabs.Tab;
    try {
      const earlyUpdate = earlyUpdates.get(created.id);
      if (earlyUpdate?.url !== undefined && enforceUrlPolicy(earlyUpdate.url).ok) {
        handle.cancel();
        reached = earlyUpdate;
      } else {
        reached = (await handle.promise).tab;
      }
    } catch {
      return { ok: false, error: { code: "lifecycle_timeout", message: "Tab did not reach a controllable URL" } };
    }

    if (reached.url === undefined) {
      return { ok: false, error: { code: "chrome_api_error", message: "Created tab has no URL" } };
    }
    const reachedUrl = reached.url;
    return this.completeLifecycle(startedAt, "controllable_url_and_attach", settle, () =>
      this.attachTab(openedId, reachedUrl),
    );
  }

  async switchTab(tabId: number, settle?: ActionSettleContext): Promise<TabLifecycleResult> {
    const startedAt = Date.now();
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

    if (tab.active) {
      handle.cancel();
    } else {
      try {
        await handle.promise;
      } catch {
        return { ok: false, error: { code: "lifecycle_timeout", message: "Tab did not activate" } };
      }
    }

    const existing = this.pages.get(tabId);
    if (existing) {
      if (existing.attached) {
        this.selectedTab = tabId;
        this.deps.diagnostics({ type: "attach_reused", tabId });
        return { ok: true, tabId, measured: this.lifecycleEvidence("activation_and_attach", startedAt, settle) };
      }
      return this.completeLifecycle(startedAt, "activation_and_attach", settle, () => this.runAttach(existing));
    }

    if (tab.url === undefined) {
      return { ok: false, error: { code: "inaccessible_tab", message: "Tab URL is not exposed" } };
    }
    const reachedUrl = tab.url;
    const policy = enforceUrlPolicy(reachedUrl);
    if (!policy.ok) {
      return { ok: false, error: policy.error };
    }
    return this.completeLifecycle(startedAt, "activation_and_attach", settle, () =>
      this.attachTab(tabId, reachedUrl),
    );
  }

  async navigate(url: string, settle?: ActionSettleContext): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.navigate(url, settle);
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

  async goBack(settle?: ActionSettleContext): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.goBack(settle);
  }

  async refresh(settle?: ActionSettleContext): Promise<NavResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.reload(settle);
  }

  async click(target: GroundedTarget, settle?: ActionSettleContext): Promise<ClickResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.click(target, settle);
  }

  async type(target: GroundedTarget, text: string, settle?: ActionSettleContext): Promise<TypeResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.type(target, text, settle);
  }

  async clearInput(target: GroundedTarget, settle?: ActionSettleContext): Promise<ClearInputResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.clearInput(target, settle);
  }

  async keypress(input: KeypressInput, settle?: ActionSettleContext): Promise<KeypressResult> {
    if (input.target) {
      const page = this.pages.get(input.target.tabId);
      if (!page) {
        return {
          ok: false,
          error: { code: "stale_ref", message: "No page connection for this tab", target: input.target },
        };
      }
      return page.keypress(input, settle);
    }
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.keypress(input, settle);
  }

  async scroll(input: ScrollInput, settle?: ActionSettleContext): Promise<ScrollResult> {
    if (input.target) {
      const page = this.pages.get(input.target.tabId);
      if (!page) {
        return {
          ok: false,
          error: { code: "stale_ref", message: "No page connection for this tab", target: input.target },
        };
      }
      return page.scroll(input, settle);
    }
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.scroll(input, settle);
  }

  async scrollToText(text: string, occurrence: number, settle?: ActionSettleContext): Promise<ScrollResult> {
    const page = this.selectedPage();
    if (!page) {
      return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
    }
    return page.scrollToText(text, occurrence, settle);
  }

  async getSelectOptions(target: GroundedTarget): Promise<GetSelectOptionsResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.getSelectOptions(target);
  }

  async selectOption(
    target: GroundedTarget,
    option: SelectOptionIdentity,
    settle?: ActionSettleContext,
  ): Promise<SelectOptionResult> {
    const page = this.pages.get(target.tabId);
    if (!page) {
      return { ok: false, error: { code: "stale_ref", message: "No page connection for this tab", target } };
    }
    return page.selectOption(target, option, settle);
  }

  async closeTab(tabId: number, settle?: ActionSettleContext): Promise<TabLifecycleResult> {
    const startedAt = Date.now();
    if (!this.pages.has(tabId)) {
      return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
    }

    const check = await this.confirmRemoval(tabId, settle);
    switch (check.kind) {
      case "missing_tab":
        return { ok: false, error: { code: "missing_tab", message: "No such tab" } };
      case "chrome_error":
        return { ok: false, error: { code: "chrome_api_error", message: "Could not close tab" } };
      case "timeout":
        // removeTab was already dispatched; Chrome just never answered.
        // That is uncertainty about a dispatched mutation, not a queue
        // expiry, so it reports lifecycle_timeout instead of
        // action_wait_timeout. Local state stays until removal is proven.
        return {
          ok: false,
          error: { code: "lifecycle_timeout", message: "Close did not finish before the deadline" },
        };
      case "cancelled":
        return {
          ok: false,
          error: { code: "action_cancelled", message: "Browser action was cancelled during dispatch", dispatchStarted: true },
        };
      case "removed":
        break;
    }

    // Chrome confirmed the removal, so local connection state may be
    // discarded. Clearing the registry first keeps any late removal event a
    // no-op instead of a second teardown.
    const managed = this.pages.get(tabId);
    this.removeTabRecord(tabId);
    if (managed) {
      const disconnected = await managed.disconnect();
      if (!disconnected.ok) {
        return { ok: false, error: disconnected.error };
      }
    }
    return { ok: true, tabId, measured: this.lifecycleEvidence("removal_confirmed", startedAt, settle) };
  }

  private lifecycleEvidence(
    completedBy: TabCompletionSource,
    startedAt: number,
    settle?: ActionSettleContext,
  ): TabLifecycleMeasurement {
    return {
      actionId: settle?.actionId ?? createActionId(),
      lifecycle: { status: "completed", completedBy, elapsedMs: Date.now() - startedAt },
    };
  }

  private async completeLifecycle(
    startedAt: number,
    completedBy: TabCompletionSource,
    settle: ActionSettleContext | undefined,
    attach: () => Promise<AttachResult>,
  ): Promise<TabLifecycleResult> {
    const result = await attach();
    if (!result.ok) {
      return result;
    }
    return { ok: true, tabId: result.tabId, measured: this.lifecycleEvidence(completedBy, startedAt, settle) };
  }

  // Arms tabs.onRemoved before asking Chrome to remove the tab. Confirmation
  // is whichever Chrome signal lands first: the removal event for this tab or
  // the remove call resolving without error. Aborts and the remaining budget
  // cap the wait; every path tears down its listener and timer.
  private confirmRemoval(tabId: number, settle?: ActionSettleContext): Promise<RemovalCheck> {
    const capMs = settle?.timeoutMs ?? this.deps.timeoutMs;

    return new Promise<RemovalCheck>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let detachAbort: (() => void) | null = null;

      const finish = (check: RemovalCheck): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        detachAbort?.();
        stopRemoved();
        resolve(check);
      };

      const stopRemoved = this.deps.onRemoved((removedId) => {
        if (removedId === tabId) {
          finish({ kind: "removed" });
        }
      });

      const signal = settle?.signal;
      if (signal?.aborted) {
        finish({ kind: "cancelled" });
        return;
      }
      if (signal) {
        const onAbort = (): void => finish({ kind: "cancelled" });
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      timer = setTimeout(() => finish({ kind: "timeout" }), capMs);

      void this.deps.removeTab(tabId).then(
        () => finish({ kind: "removed" }),
        (error: unknown) =>
          finish(
            error instanceof Error && /no tab with id/i.test(error.message)
              ? { kind: "missing_tab" }
              : { kind: "chrome_error" },
          ),
      );
    });
  }

  async cleanup(): Promise<CleanupResult> {
    const failures: BrowserError[] = [];
    // Settle every live action with the cleanup cause before tearing down
    // pages, so waits end on evidence instead of dying silently.
    this.actionCoordinator.abortAll("runtime_cleanup");
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
    // Any action still queued or dispatching against the closed tab must end
    // now, with the lifecycle cause that ended it.
    this.actionCoordinator.abortForTab(tabId, "tab_removed");
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee): void {
    if (source.tabId !== undefined) {
      this.discardPage(source.tabId);
      this.actionCoordinator.abortForTab(source.tabId, "debugger_detached");
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

    const page = new BrowserPage(tabId, url, this.pageDepsFor(tabId));
    this.pages.set(tabId, page);
    return this.runAttach(page);
  }

  // Page deps gain one hook: an unexpected connection death mid-action
  // (never context-initiated teardown) aborts that tab's scheduled actions.
  private pageDepsFor(tabId: number): PageDeps {
    const base = this.deps.pageDeps ?? defaultPageDeps;
    return {
      ...base,
      onConnectionReplaced: (replacedTabId) => {
        base.onConnectionReplaced?.(replacedTabId);
        if (replacedTabId === tabId) {
          this.actionCoordinator.abortForTab(replacedTabId, "connection_replaced");
        }
      },
    };
  }

  private runAttach(page: BrowserPage): Promise<AttachResult> {
    const inFlight = this.pending.get(page.tabId);
    if (inFlight) {
      return inFlight;
    }

    this.deps.diagnostics({ type: "attach_started", tabId: page.tabId });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pageAttempt = page.attach().catch(
      (): AttachResult => ({ ok: false, error: { code: "attach_failed", message: "Failed to attach to tab" } }),
    );
    const timeout = new Promise<AttachResult>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ ok: false, error: { code: "lifecycle_timeout", message: "Tab attachment timed out" } });
      }, this.deps.timeoutMs);
    });
    void pageAttempt.then((result) => {
      if (timedOut && result.ok) {
        return page.disconnect();
      }
    });
    const attempt = Promise.race([pageAttempt, timeout])
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
        if (timer) {
          clearTimeout(timer);
        }
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
