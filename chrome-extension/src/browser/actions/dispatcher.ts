import type { NavResult } from "../page";
import type {
  BrowserActionData,
  BrowserActionName,
  BrowserActionResult,
  BrowserActionRequest,
} from "./types";

export interface BrowserActionRuntime {
  selectedTabId: number | null;
  navigate: (url: string) => Promise<NavResult>;
  goBack: () => Promise<NavResult>;
  refresh: () => Promise<NavResult>;
}

export async function dispatchBrowserAction(
  request: BrowserActionRequest,
  runtime: BrowserActionRuntime,
): Promise<BrowserActionResult> {
  const action = request.action;
  const tabId = runtime.selectedTabId;
  if (tabId === null) {
    return {
      ok: false,
      action,
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    };
  }

  let result: NavResult;
  try {
    result = await runNavigation(request, runtime);
  } catch {
    return { ok: false, action, tabId, error: { code: "action_failed", message: "Browser action failed" } };
  }

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

function runNavigation(request: BrowserActionRequest, runtime: BrowserActionRuntime): Promise<NavResult> {
  switch (request.action) {
    case "browser_navigate":
      return runtime.navigate(request.input.url);
    case "browser_back":
      return runtime.goBack();
    case "browser_refresh":
      return runtime.refresh();
  }
}

function actionData(action: BrowserActionName): BrowserActionData {
  switch (action) {
    case "browser_navigate":
      return { kind: "navigate" };
    case "browser_back":
      return { kind: "back" };
    case "browser_refresh":
      return { kind: "refresh" };
  }
}