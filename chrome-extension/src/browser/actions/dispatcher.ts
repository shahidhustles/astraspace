import type { CloseResult, TabListResult } from "../context";
import type { AttachResult, NavResult } from "../page";
import type { GroundedTarget, TabInfo } from "../types";
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
  navigate: (url: string) => Promise<NavResult>;
  goBack: () => Promise<NavResult>;
  refresh: () => Promise<NavResult>;
  click: (target: GroundedTarget) => Promise<ClickResult>;
  type: (target: GroundedTarget, text: string) => Promise<TypeResult>;
  clearInput: (target: GroundedTarget) => Promise<ClearInputResult>;
  keypress: (input: KeypressInput) => Promise<KeypressResult>;
  scroll: (input: ScrollInput) => Promise<ScrollResult>;
  scrollToText: (text: string, occurrence: number) => Promise<ScrollResult>;
  getSelectOptions: (target: GroundedTarget) => Promise<GetSelectOptionsResult>;
  selectOption: (target: GroundedTarget, option: SelectOptionIdentity) => Promise<SelectOptionResult>;
  openTab: (url: string) => Promise<AttachResult>;
  switchTab: (tabId: number) => Promise<AttachResult>;
  closeTab: (tabId: number) => Promise<CloseResult>;
  listTabs: () => Promise<TabListResult>;
}

export async function dispatchBrowserAction(
  request: BrowserActionRequest,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const action = request.action;
  try {
    switch (action) {
      case "browser_navigate":
        return await navigationAction("browser_navigate", () => runtime.navigate(request.input.url), runtime);
      case "browser_back":
        return await navigationAction("browser_back", () => runtime.goBack(), runtime);
      case "browser_refresh":
        return await navigationAction("browser_refresh", () => runtime.refresh(), runtime);
      case "browser_click":
        return await clickAction(request.input, runtime);
      case "browser_type":
        return await mutatingTargetAction(
          "browser_type",
          request.input.target,
          () => runtime.type(request.input.target, request.input.text),
          runtime,
        );
      case "browser_clear_input":
        return await mutatingTargetAction(
          "browser_clear_input",
          request.input,
          () => runtime.clearInput(request.input),
          runtime,
        );
      case "browser_keypress":
        return await keypressAction(request.input, runtime);
      case "browser_scroll":
        return await scrollAction(request.input, runtime);
      case "browser_scroll_to_text":
        return await scrollToTextAction(request.input, runtime);
      case "browser_get_select_options":
        return await selectOptionsAction(request.input, runtime);
      case "browser_select_option":
        return await selectOptionAction(request.input, runtime);
      case "browser_open_tab":
        return await tabLifecycleAction(
          "browser_open_tab",
          () => runtime.openTab(request.input.url),
          request.input.url,
          runtime,
        );
      case "browser_switch_tab":
        return await tabLifecycleAction("browser_switch_tab", () => runtime.switchTab(request.input.tabId), "", runtime);
      case "browser_close_tab":
        return await tabLifecycleAction("browser_close_tab", () => runtime.closeTab(request.input.tabId), "", runtime);
    }
  } catch {
    return { ok: false, action, tabId: runtime.selectedTabId, error: { code: "action_failed", message: "Browser action failed" } };
  }
}

async function navigationAction(
  action: "browser_navigate" | "browser_back" | "browser_refresh",
  run: () => Promise<NavResult>,
  runtime: BrowserActionRuntime,
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
  return {
    ok: true,
    action,
    tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: actionData(action),
  };
}

async function clickAction(target: GroundedTarget, runtime: BrowserActionRuntime): Promise<BrowserActionResult> {
  const result = await runtime.click(target);
  if (!result.ok) {
    return { ok: false, action: "browser_click", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_click",
    tabId: target.tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: { kind: "click", newTabId: result.newTabId },
  };
}

async function mutatingTargetAction(
  action: "browser_type" | "browser_clear_input",
  target: GroundedTarget,
  run: () => Promise<TypeResult | ClearInputResult>,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const result = await run();
  if (!result.ok) {
    return { ok: false, action, tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action,
    tabId: target.tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: action === "browser_type" ? { kind: "type" } : { kind: "clear_input" },
  };
}

async function keypressAction(input: KeypressInput, runtime: BrowserActionRuntime): Promise<BrowserActionResult> {
  const tabId = input.target?.tabId ?? runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action: "browser_keypress",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await runtime.keypress(input);
  if (!result.ok) {
    return { ok: false, action: "browser_keypress", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_keypress",
    tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: { kind: "keypress" },
  };
}

async function scrollAction(input: ScrollInput, runtime: BrowserActionRuntime): Promise<BrowserActionResult> {
  const tabId = input.target?.tabId ?? runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action: "browser_scroll",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }
  const result = await runtime.scroll(input);
  if (!result.ok) {
    return { ok: false, action: "browser_scroll", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_scroll",
    tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: { kind: "scroll", x: result.position.x, y: result.position.y },
  };
}

async function scrollToTextAction(
  input: { text: string; occurrence: number },
  runtime: BrowserActionRuntime,
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
  const result = await runtime.scrollToText(input.text, input.occurrence);
  if (!result.ok) {
    return { ok: false, action: "browser_scroll_to_text", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_scroll_to_text",
    tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: { kind: "scroll_to_text", x: result.position.x, y: result.position.y },
  };
}

async function selectOptionsAction(
  target: GroundedTarget,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const result = await runtime.getSelectOptions(target);
  if (!result.ok) {
    return { ok: false, action: "browser_get_select_options", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_get_select_options",
    tabId: target.tabId,
    url: result.url,
    snapshotInvalidated: false,
    data: { kind: "get_select_options", options: result.options },
  };
}

async function selectOptionAction(
  input: { target: GroundedTarget; index: number; label: string; value: string },
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const identity: SelectOptionIdentity = { index: input.index, label: input.label, value: input.value };
  const result = await runtime.selectOption(input.target, identity);
  if (!result.ok) {
    return { ok: false, action: "browser_select_option", tabId: runtime.selectedTabId, error: result.error };
  }
  return {
    ok: true,
    action: "browser_select_option",
    tabId: input.target.tabId,
    url: result.url,
    snapshotInvalidated: true,
    data: { kind: "select_option", selectedIndex: result.selectedIndex },
  };
}

async function tabLifecycleAction(
  action: "browser_open_tab" | "browser_switch_tab" | "browser_close_tab",
  run: () => Promise<AttachResult | CloseResult>,
  urlFallback: string,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const result = await run();
  if (!result.ok) {
    return { ok: false, action, tabId: runtime.selectedTabId, error: result.error };
  }
  const tabs = await listedTabs(runtime);
  const url = tabs?.find((tab) => tab.tabId === result.tabId)?.url ?? urlFallback;
  return {
    ok: true,
    action,
    tabId: result.tabId,
    url,
    snapshotInvalidated: true,
    data: tabActionData(action, tabs),
  };
}

async function listedTabs(runtime: BrowserActionRuntime): Promise<TabInfo[] | null> {
  const result = await runtime.listTabs();
  return result.ok ? result.tabs : null;
}

function tabActionData(
  action: "browser_open_tab" | "browser_switch_tab" | "browser_close_tab",
  tabs: TabInfo[] | null,
): BrowserActionData {
  switch (action) {
    case "browser_open_tab":
      return { kind: "open_tab", tabs };
    case "browser_switch_tab":
      return { kind: "switch_tab", tabs };
    case "browser_close_tab":
      return { kind: "close_tab", tabs };
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
