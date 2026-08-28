import type { TabLifecycleResult, TabListResult } from "../context";
import type { NavResult } from "../page";
import type { GroundedTarget, TabInfo } from "../types";
import {
  boundText,
  type ActionCompletionEvidence,
  type ActionCompletionStatus,
  type ActionSettleContext,
  type TabLifecycleMeasurement,
} from "../waits/types";
import {
  clickCompletionStatus,
  scrollCompletionStatus,
  signalsCompletionStatus,
} from "../waits/status";
import type {
  BrowserActionResult,
  BrowserActionRequest,
  BrowserActionData,
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
} from "./types";

export interface BrowserActionRuntime {
  selectedTabId: number | null;
  navigate: (url: string, settle?: ActionSettleContext) => Promise<NavResult>;
  goBack: (settle?: ActionSettleContext) => Promise<NavResult>;
  refresh: (settle?: ActionSettleContext) => Promise<NavResult>;
  click: (target: GroundedTarget, settle?: ActionSettleContext) => Promise<ClickResult>;
  type: (target: GroundedTarget, text: string, settle?: ActionSettleContext) => Promise<TypeResult>;
  clearInput: (target: GroundedTarget, settle?: ActionSettleContext) => Promise<ClearInputResult>;
  keypress: (input: KeypressInput, settle?: ActionSettleContext) => Promise<KeypressResult>;
  scroll: (input: ScrollInput, settle?: ActionSettleContext) => Promise<ScrollResult>;
  scrollToText: (text: string, occurrence: number, settle?: ActionSettleContext) => Promise<ScrollResult>;
  getSelectOptions: (target: GroundedTarget) => Promise<GetSelectOptionsResult>;
  selectOption: (
    target: GroundedTarget,
    option: SelectOptionIdentity,
    settle?: ActionSettleContext,
  ) => Promise<SelectOptionResult>;
  openTab: (url: string, settle?: ActionSettleContext) => Promise<TabLifecycleResult>;
  switchTab: (tabId: number, settle?: ActionSettleContext) => Promise<TabLifecycleResult>;
  closeTab: (tabId: number, settle?: ActionSettleContext) => Promise<TabLifecycleResult>;
  listTabs: () => Promise<TabListResult>;
}

// Opening a tab does not need an existing page. It still gets a coordinator
// lane so open-tab requests remain serialized without pretending a real tab
// is selected.
export const OPEN_TAB_COORDINATION_ID = -1;

// One place decides which tab an action acts on, so scheduling and dispatch
// agree. Targeted actions use their target's tab; everything else follows the
// selected tab.
export function resolveActionTabId(request: BrowserActionRequest, selectedTabId: number | null): number | null {
  switch (request.action) {
    case "browser_open_tab":
      return OPEN_TAB_COORDINATION_ID;
    case "browser_click":
    case "browser_clear_input":
    case "browser_get_select_options":
      return request.input.tabId;
    case "browser_type":
      return request.input.target.tabId;
    case "browser_select_option":
      return request.input.target.tabId;
    case "browser_keypress":
    case "browser_scroll":
      return request.input.target ? request.input.target.tabId : selectedTabId;
    default:
      return selectedTabId;
  }
}

export async function dispatchBrowserAction(
  request: BrowserActionRequest,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const action = request.action;
  let result: BrowserActionResult;
  try {
    result = await routeBrowserAction(request, runtime, settle);
  } catch {
    result = {
      ok: false,
      action,
      tabId: runtime.selectedTabId,
      error: { code: "action_failed", message: "Browser action failed" },
    };
  }
  return withCompletion(result, settle);
}

// One completion record rides every dispatched envelope: successes report
// whether settling proved, failures say cancelled/timed_out/failed by their
// error code. Handler-stamped evidence (navigation timeout uncertainty) wins.
function withCompletion(result: BrowserActionResult, settle?: ActionSettleContext): BrowserActionResult {
  if (!settle || result.completion) {
    return result;
  }
  const completion: ActionCompletionEvidence = {
    actionId: settle.actionId,
    status: deriveStatus(result),
    elapsedMs: Math.max(0, Date.now() - settle.startedAtMs),
    dispatchStarted: true,
  };
  return { ...result, completion };
}

function deriveStatus(result: BrowserActionResult): ActionCompletionStatus {
  if (result.ok) {
    return successCompletion(result);
  }
  switch (result.error.code) {
    case "action_cancelled":
      return "cancelled";
    case "lifecycle_timeout":
      return "timed_out";
    default:
      return "failed";
  }
}

// Derives success statuses from each family's own evidence so one place maps
// data shapes to the completed-versus-timed_out distinction.
function successCompletion(result: Extract<BrowserActionResult, { ok: true }>): ActionCompletionStatus {
  switch (result.data.kind) {
    case "click":
      return clickCompletionStatus(result.data.measured ?? {});
    case "type":
    case "clear_input":
    case "keypress":
    case "select_option":
      return signalsCompletionStatus(result.signals);
    case "scroll":
    case "scroll_to_text":
      return scrollCompletionStatus(result.data.measured?.stability);
    default:
      return "completed";
  }
}

async function routeBrowserAction(
  request: BrowserActionRequest,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  switch (request.action) {
    case "browser_navigate":
      return await navigationAction("browser_navigate", () => runtime.navigate(request.input.url, settle), runtime, settle);
    case "browser_back":
      return await navigationAction("browser_back", () => runtime.goBack(settle), runtime, settle);
    case "browser_refresh":
      return await navigationAction("browser_refresh", () => runtime.refresh(settle), runtime, settle);
    case "browser_click":
      return await clickAction(request.input, runtime, settle);
    case "browser_type":
      return await mutatingTargetAction(
        "browser_type",
        request.input.target,
        () => runtime.type(request.input.target, request.input.text, settle),
      );
    case "browser_clear_input":
      return await mutatingTargetAction(
        "browser_clear_input",
        request.input,
        () => runtime.clearInput(request.input, settle),
      );
    case "browser_keypress":
      return await keypressAction(request.input, runtime, settle);
    case "browser_scroll":
      return await scrollAction(request.input, runtime, settle);
    case "browser_scroll_to_text":
      return await scrollToTextAction(request.input, runtime, settle);
    case "browser_get_select_options":
      return await selectOptionsAction(request.input, runtime, settle);
    case "browser_select_option":
      return await selectOptionAction(request.input, runtime, settle);
    case "browser_open_tab":
      return await tabLifecycleAction(
        "browser_open_tab",
        () => runtime.openTab(request.input.url, settle),
        request.input.url,
        runtime,
      );
    case "browser_switch_tab":
      return await tabLifecycleAction(
        "browser_switch_tab",
        () => runtime.switchTab(request.input.tabId, settle),
        "",
        runtime,
      );
    case "browser_close_tab":
      return await tabLifecycleAction(
        "browser_close_tab",
        () => runtime.closeTab(request.input.tabId, settle),
        "",
        runtime,
      );
  }
}

async function navigationAction(
  action: "browser_navigate" | "browser_back" | "browser_refresh",
  run: () => Promise<NavResult>,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const tabId = runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action,
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await run();
  if (!result.ok) {
    return { ok: false, action, tabId, error: result.error };
  }
  if ("timedOut" in result) {
    // Dispatched but unproven landing: truthful uncertainty on an envelope
    // that still reports the invalidation.
    return {
      ok: true,
      action,
      tabId,
      url: boundText(result.url),
      snapshotInvalidated: true,
      data: actionData(action),
      ...(settle
        ? {
            completion: {
              actionId: settle.actionId,
              status: "timed_out" as const,
              elapsedMs: Math.max(0, Date.now() - settle.startedAtMs),
              dispatchStarted: true,
            },
          }
        : {}),
    };
  }
  return {
    ok: true,
    action,
    tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    data: actionData(action),
  };
}

async function clickAction(
  target: GroundedTarget,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const result = await runtime.click(target, settle);
  if (!result.ok) {
    return { ok: false, action: "browser_click", tabId: target.tabId, error: result.error };
  }
  const measured = result.measurement;
  return {
    ok: true,
    action: "browser_click",
    tabId: target.tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    ...(measured?.signals ? { signals: measured.signals } : {}),
    data: {
      kind: "click",
      newTabId: result.newTabId,
      ...(measured && Object.keys(measured).length > 0 ? { measured } : {}),
    },
  };
}

async function mutatingTargetAction(
  action: "browser_type" | "browser_clear_input",
  target: GroundedTarget,
  run: () => Promise<TypeResult | ClearInputResult>,
): Promise<BrowserActionResult> {
  const result = await run();
  if (!result.ok) {
    return { ok: false, action, tabId: target.tabId, error: result.error };
  }
  return {
    ok: true,
    action,
    tabId: target.tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    ...(result.signals ? { signals: result.signals } : {}),
    data: action === "browser_type" ? { kind: "type" } : { kind: "clear_input" },
  };
}

async function keypressAction(
  input: KeypressInput,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const tabId = input.target?.tabId ?? runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action: "browser_keypress",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await runtime.keypress(input, settle);
  if (!result.ok) {
    return { ok: false, action: "browser_keypress", tabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_keypress",
    tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    ...(result.signals ? { signals: result.signals } : {}),
    data: { kind: "keypress" },
  };
}

async function scrollAction(
  input: ScrollInput,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const tabId = input.target?.tabId ?? runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action: "browser_scroll",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await runtime.scroll(input, settle);
  return scrollEnvelope("browser_scroll", tabId, result, "scroll");
}

async function scrollToTextAction(
  input: { text: string; occurrence: number },
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const tabId = runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action: "browser_scroll_to_text",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await runtime.scrollToText(input.text, input.occurrence, settle);
  return scrollEnvelope("browser_scroll_to_text", tabId, result, "scroll_to_text");
}

// Shared success mapping for both scroll actions: settle signals ride the
// envelope and stability evidence lands in data.measured, mirroring clicks.
function scrollEnvelope(
  action: "browser_scroll" | "browser_scroll_to_text",
  tabId: number,
  result: ScrollResult,
  kind: "scroll" | "scroll_to_text",
): BrowserActionResult {
  if (!result.ok) {
    return { ok: false, action, tabId, error: result.error };
  }
  const measured = result.measurement;
  return {
    ok: true,
    action,
    tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    ...(measured?.signals ? { signals: measured.signals } : {}),
    data: {
      kind,
      x: result.position.x,
      y: result.position.y,
      ...(measured && Object.keys(measured).length > 0 ? { measured } : {}),
    },
  };
}

async function selectOptionsAction(
  target: GroundedTarget,
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const startedAt = Date.now();
  const result = await runtime.getSelectOptions(target);
  if (!result.ok) {
    return { ok: false, action: "browser_get_select_options", tabId: target.tabId, error: result.error };
  }
  // Read-only inspection finishes the moment the read lands; recording that
  // keeps every completion carrying evidence without invalidating anything.
  const measured: TabLifecycleMeasurement | undefined = settle?.actionId
    ? {
        actionId: settle.actionId,
        lifecycle: { status: "completed", completedBy: "read_only_inspection", elapsedMs: Date.now() - startedAt },
      }
    : undefined;
  return {
    ok: true,
    action: "browser_get_select_options",
    tabId: target.tabId,
    url: boundText(result.url),
    snapshotInvalidated: false,
    data: {
      kind: "get_select_options",
      options: result.options,
      optionsTruncated: result.optionsTruncated,
      ...(measured ? { measured } : {}),
    },
  };
}

async function selectOptionAction(
  input: { target: GroundedTarget; index: number; label: string; value: string },
  runtime: BrowserActionRuntime,
  settle?: ActionSettleContext,
): Promise<BrowserActionResult> {
  const identity: SelectOptionIdentity = { index: input.index, label: input.label, value: input.value };
  const result = await runtime.selectOption(input.target, identity, settle);
  if (!result.ok) {
    return { ok: false, action: "browser_select_option", tabId: input.target.tabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_select_option",
    tabId: input.target.tabId,
    url: boundText(result.url),
    snapshotInvalidated: true,
    ...(result.signals ? { signals: result.signals } : {}),
    data: { kind: "select_option", selectedIndex: result.selectedIndex },
  };
}

// Shared mapping for the three tab lifecycle actions. The envelope's tab
// identity follows the prior contract (close reports the surviving selected
// tab), snapshot truth is aligned with what the context actually invalidates,
// and the context-supplied measurement carries action id, elapsed time, and
// the Chrome signal that completed it.
async function tabLifecycleAction(
  action: "browser_open_tab" | "browser_switch_tab" | "browser_close_tab",
  run: () => Promise<TabLifecycleResult>,
  urlFallback: string,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const result = await run();
  if (!result.ok) {
    return { ok: false, action, tabId: runtime.selectedTabId, error: result.error };
  }
  const tabs = await listedTabs(runtime);
  const selectedTab = tabs?.find((tab) => tab.selected);
  const reportedTab = action === "browser_close_tab" && selectedTab ? selectedTab : undefined;
  const tabId = reportedTab?.tabId ?? result.tabId;
  const url = boundText(reportedTab?.url ?? tabs?.find((tab) => tab.tabId === result.tabId)?.url ?? urlFallback);
  return {
    ok: true,
    action,
    tabId,
    url,
    snapshotInvalidated: action === "browser_close_tab",
    data: tabActionData(action, tabs, result.measured),
  };
}

async function listedTabs(runtime: BrowserActionRuntime): Promise<TabInfo[] | null> {
  const result = await runtime.listTabs();
  return result.ok ? result.tabs : null;
}

function tabActionData(
  action: "browser_open_tab" | "browser_switch_tab" | "browser_close_tab",
  tabs: TabInfo[] | null,
  measured?: TabLifecycleMeasurement,
): BrowserActionData {
  switch (action) {
    case "browser_open_tab":
      return { kind: "open_tab", tabs, ...(measured ? { measured } : {}) };
    case "browser_switch_tab":
      return { kind: "switch_tab", tabs, ...(measured ? { measured } : {}) };
    case "browser_close_tab":
      return { kind: "close_tab", tabs, ...(measured ? { measured } : {}) };
  }
}

function actionData(action: "browser_navigate" | "browser_back" | "browser_refresh"): BrowserActionData {
  switch (action) {
    case "browser_navigate":
      return { kind: "navigate" };
    case "browser_back":
      return { kind: "back" };
    case "browser_refresh":
      return { kind: "refresh" };
  }
}
