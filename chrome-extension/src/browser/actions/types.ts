import type { BrowserError, GroundedTarget, TabInfo } from "../types";

export const BROWSER_ACTION_MESSAGE = "browser.action";

export type BrowserActionName =
  | "browser_navigate"
  | "browser_back"
  | "browser_refresh"
  | "browser_click"
  | "browser_type"
  | "browser_clear_input"
  | "browser_keypress"
  | "browser_scroll"
  | "browser_scroll_to_text"
  | "browser_get_select_options"
  | "browser_select_option"
  | "browser_open_tab"
  | "browser_switch_tab"
  | "browser_close_tab";

export type BrowserScrollMode =
  | { mode: "page_up" }
  | { mode: "page_down" }
  | { mode: "top" }
  | { mode: "bottom" }
  | { mode: "percent"; percent: number };

export interface KeypressModifiers {
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
}

export interface KeypressInput {
  key: string;
  modifiers: KeypressModifiers;
  target: GroundedTarget | null;
}

export interface ScrollInput {
  mode: BrowserScrollMode;
  target?: GroundedTarget;
}

export interface SelectOption {
  index: number;
  label: string;
  value: string;
  disabled: boolean;
  selected: boolean;
}

export interface SelectOptionIdentity {
  index: number;
  label: string;
  value: string;
}

export type BrowserActionRequest =
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_navigate"; input: { url: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_back"; input: Record<string, never> }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_refresh"; input: Record<string, never> }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_click"; input: GroundedTarget }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_type"; input: { target: GroundedTarget; text: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_clear_input"; input: GroundedTarget }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_keypress"; input: KeypressInput }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_scroll"; input: ScrollInput }
  | {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_scroll_to_text";
      input: { text: string; occurrence: number };
    }
  | {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_get_select_options";
      input: GroundedTarget;
    }
  | {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_select_option";
      input: { target: GroundedTarget; index: number; label: string; value: string };
    }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_open_tab"; input: { url: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_switch_tab"; input: { tabId: number } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_close_tab"; input: { tabId: number } };

export type BrowserActionData =
  | { kind: "navigate" }
  | { kind: "back" }
  | { kind: "refresh" }
  | { kind: "click"; newTabId: number | null }
  | { kind: "type" }
  | { kind: "clear_input" }
  | { kind: "keypress" }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "scroll_to_text"; x: number; y: number }
  | { kind: "get_select_options"; options: SelectOption[] }
  | { kind: "select_option"; selectedIndex: number }
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

export interface ReadOnlyTargetError {
  code: "read_only_target";
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

export interface TextNotFoundError {
  code: "text_not_found";
  message: string;
}

export interface NotNativeSelectError {
  code: "not_native_select";
  message: string;
}

export interface OptionNotFoundError {
  code: "option_not_found";
  message: string;
}

export interface OptionDisabledError {
  code: "option_disabled";
  message: string;
}

export interface AmbiguousOptionError {
  code: "ambiguous_option";
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
  | ReadOnlyTargetError
  | NotInteractableError
  | FileUploadRequiredError
  | TextNotFoundError
  | NotNativeSelectError
  | OptionNotFoundError
  | OptionDisabledError
  | AmbiguousOptionError
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

export type TypeResult = { ok: true; url: string } | { ok: false; error: BrowserActionError };

export type ClearInputResult = { ok: true; url: string } | { ok: false; error: BrowserActionError };

export type KeypressResult = { ok: true; url: string } | { ok: false; error: BrowserActionError };

export interface ScrollPosition {
  x: number;
  y: number;
}

export type ScrollResult =
  | { ok: true; url: string; position: ScrollPosition }
  | { ok: false; error: BrowserActionError };

export type GetSelectOptionsResult =
  | { ok: true; url: string; options: SelectOption[] }
  | { ok: false; error: BrowserActionError };

export type SelectOptionResult =
  | { ok: true; url: string; selectedIndex: number }
  | { ok: false; error: BrowserActionError };
