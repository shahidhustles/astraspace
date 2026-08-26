import type { BrowserError, GroundedTarget, TabInfo } from "../types";

export const BROWSER_ACTION_MESSAGE = "browser.action";

export type BrowserActionName =
  | "browser_navigate"
  | "browser_back"
  | "browser_refresh"
  | "browser_click"
  | "browser_open_tab"
  | "browser_switch_tab"
  | "browser_close_tab";

export type BrowserActionRequest =
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_navigate"; input: { url: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_back"; input: Record<string, never> }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_refresh"; input: Record<string, never> }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_click"; input: GroundedTarget }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_open_tab"; input: { url: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_switch_tab"; input: { tabId: number } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_close_tab"; input: { tabId: number } };

export type BrowserActionData =
  | { kind: "navigate" }
  | { kind: "back" }
  | { kind: "refresh" }
  | { kind: "click"; newTabId: number | null }
  | { kind: "open_tab"; tabs: TabInfo[] | null }
  | { kind: "switch_tab"; tabs: TabInfo[] | null }
  | { kind: "close_tab"; tabs: TabInfo[] | null };

export interface InvalidActionError {
  code: "invalid_action";
  message: string;
}

export interface ActionFailedError {
  code: "action_failed";
  message: string;
}

export interface DisabledTargetError {
  code: "disabled_target";
  message: string;
}

export interface NotInteractableError {
  code: "not_interactable";
  message: string;
}

export interface FileUploadRequiredError {
  code: "file_upload_required";
  message: string;
}

export interface GroundedTargetError {
  code: "stale_ref" | "target_not_found" | "ambiguous_ref";
  message: string;
  target: GroundedTarget;
}

export type BrowserActionError =
  | BrowserError
  | InvalidActionError
  | ActionFailedError
  | DisabledTargetError
  | NotInteractableError
  | FileUploadRequiredError
  | GroundedTargetError;

export type BrowserActionResult =
  | {
      ok: true;
      action: BrowserActionName;
      tabId: number;
      url: string;
      snapshotInvalidated: boolean;
      data: BrowserActionData;
    }
  | {
      ok: false;
      action: BrowserActionName | null;
      tabId: number | null;
      error: BrowserActionError;
    };

export type ClickResult =
  | { ok: true; url: string; newTabId: number | null }
  | { ok: false; error: BrowserActionError };
