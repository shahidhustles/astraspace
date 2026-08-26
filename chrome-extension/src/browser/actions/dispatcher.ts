import type { CloseResult, TabListResult } from "../context";
import type { AttachResult, NavResult } from "../page";
import type { GroundedTarget, TabInfo } from "../types";
import type { BrowserActionResult, BrowserActionRequest, BrowserActionData, ClickResult } from "./types";

export interface BrowserActionRuntime {
  selectedTabId: number | null;
  navigate: (url: string) => Promise<NavResult>;
  goBack: () => Promise<NavResult>;
  refresh: () => Promise<NavResult>;
  click: (target: GroundedTarget) => Promise<ClickResult>;
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
