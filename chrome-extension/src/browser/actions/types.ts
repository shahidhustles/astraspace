import type {
  ActionId,
  ActionSettleSignals,
  ExpectationSignal,
  LayoutSignal,
  NavigationCommitRecord,
} from "../waits/types";
import type { BrowserError, GroundedTarget, TabInfo } from "../types";

export const BROWSER_ACTION_MESSAGE = "browser.action";

export const BROWSER_ACTION_CANCEL_MESSAGE = "browser.action.cancel";

// Upper bound on option records returned by one browser_get_select_options call.
// Records are always complete; identity fields are never truncated.
export const SELECT_OPTIONS_LIMIT = 50;

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

// Request-level fields shared by every action. They live beside `input`,
// never inside it, so action-specific inputs stay untouched.
export interface BrowserActionEnvelope {
  actionId: ActionId | null;
  wait: ActionWaitPolicy | null;
}

export interface ActionExpectationPolicy {
  intent: "appear" | "disappear";
  role: string;
  name: string;
}

export interface ActionWaitPolicy {
  timeoutMs: number | null;
  expectation: ActionExpectationPolicy | null;
}

export type BrowserActionRequest =
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_navigate"; input: { url: string } })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_back"; input: Record<string, never> })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_refresh"; input: Record<string, never> })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_click"; input: GroundedTarget })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_type"; input: { target: GroundedTarget; text: string } })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_clear_input"; input: GroundedTarget })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_keypress"; input: KeypressInput })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_scroll"; input: ScrollInput })
  | (BrowserActionEnvelope & {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_scroll_to_text";
      input: { text: string; occurrence: number };
    })
  | (BrowserActionEnvelope & {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_get_select_options";
      input: GroundedTarget;
    })
  | (BrowserActionEnvelope & {
      type: typeof BROWSER_ACTION_MESSAGE;
      action: "browser_select_option";
      input: { target: GroundedTarget; index: number; label: string; value: string };
    })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_open_tab"; input: { url: string } })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_switch_tab"; input: { tabId: number } })
  | (BrowserActionEnvelope & { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_close_tab"; input: { tabId: number } });

export type BrowserActionData =
  | { kind: "navigate" }
  | { kind: "back" }
  | { kind: "refresh" }
  | { kind: "click"; newTabId: number | null; measured?: ClickMeasurement }
  | { kind: "type" }
  | { kind: "clear_input" }
  | { kind: "keypress" }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "scroll_to_text"; x: number; y: number }
  | { kind: "get_select_options"; options: SelectOption[]; optionsTruncated: boolean }
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

export interface ActionCancelledError {
  code: "action_cancelled";
  message: string;
  dispatchStarted: boolean;
}

export interface ActionWaitTimeoutError {
  code: "action_wait_timeout";
  message: string;
}

export interface UnknownActionIdError {
  code: "unknown_action_id";
  message: string;
}

export type BrowserActionError =
  | BrowserError
  | InvalidActionError
  | ActionFailedError
  | ActionCancelledError
  | ActionWaitTimeoutError
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
      signals?: ActionSettleSignals;
    }
  | {
      ok: false;
      action: BrowserActionName | null;
      tabId: number | null;
      error: BrowserActionError;
    };

// What a click measured between activation and settlement. `outcome` names the
// strongest evidence found: a document swap beats a route change beats a
// stable layout. Commits list every recorded hop either way.
export interface ClickMeasurement {
  outcome?: "navigation" | "same_document" | "dom_update";
  commits?: NavigationCommitRecord[];
  expectation?: ExpectationSignal;
  layout?: LayoutSignal;
  signals?: ActionSettleSignals;
}

// Evidence handed back by the click settle barrier. The barrier reports the
// popup tab it held open even when it returns partial or cancelled evidence.
export type ClickCapture =
  | { ok: true; newTabId: number | null; measurement: ClickMeasurement; finalUrl?: string }
  | { ok: false; error: BrowserActionError };

export type ClickResult =
  | { ok: true; url: string; newTabId: number | null; measurement?: ClickMeasurement }
  | { ok: false; error: BrowserActionError };

export type TypeResult =
  | { ok: true; url: string; signals?: ActionSettleSignals }
  | { ok: false; error: BrowserActionError };

export type ClearInputResult =
  | { ok: true; url: string; signals?: ActionSettleSignals }
  | { ok: false; error: BrowserActionError };

export type KeypressResult =
  | { ok: true; url: string; signals?: ActionSettleSignals }
  | { ok: false; error: BrowserActionError };

export interface ScrollPosition {
  x: number;
  y: number;
}

export type ScrollResult =
  | { ok: true; url: string; position: ScrollPosition }
  | { ok: false; error: BrowserActionError };

export type GetSelectOptionsResult =
  | { ok: true; url: string; options: SelectOption[]; optionsTruncated: boolean }
  | { ok: false; error: BrowserActionError };

export type SelectOptionResult =
  | { ok: true; url: string; selectedIndex: number; signals?: ActionSettleSignals }
  | { ok: false; error: BrowserActionError };

export type ScheduledAction =
  | { ok: true; actionId: ActionId; settled: Promise<BrowserActionResult> }
  | { ok: false; action: BrowserActionName; error: InvalidActionError };

export type BrowserActionCancelReply =
  | { ok: true; actionId: ActionId; cancelled: boolean; dispatchStarted: boolean }
  | { ok: false; actionId: ActionId | null; error: InvalidActionError | UnknownActionIdError };
