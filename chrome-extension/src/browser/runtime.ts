import { resolveActionTabId, type BrowserActionRuntime } from "./actions/dispatcher";
import {
  BROWSER_ACTION_CANCEL_MESSAGE,
  BROWSER_ACTION_MESSAGE,
  type BrowserActionCancelReply,
  type BrowserActionRequest,
  type BrowserActionResult,
  type ScheduledAction,
} from "./actions/types";
import { parseBrowserActionMessage, parseBrowserCancelMessage } from "./actions/validation";
import type { AttachResult } from "./page";
import type { ObservationResult } from "./types";
import { enqueueActionRequest, TabActionCoordinator } from "./waits/coordinator";
import type { ActionId } from "./waits/types";

export const ATTACH_ACTIVE_TAB_MESSAGE = "browser.attach-active-tab";
export const OBSERVE_SELECTED_TAB_MESSAGE = "browser.observe-selected-tab";

export interface BrowserRuntime extends BrowserActionRuntime {
  useActiveTab: () => Promise<AttachResult>;
  observe: () => Promise<ObservationResult>;
  scheduleAction: (input: { request: BrowserActionRequest; tabId: number }) => ScheduledAction;
  cancelAction: (id: ActionId) => BrowserActionCancelReply;
}

export function isAttachActiveTabMessage(message: unknown): message is { type: typeof ATTACH_ACTIVE_TAB_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === ATTACH_ACTIVE_TAB_MESSAGE
  );
}

export function isObserveSelectedTabMessage(
  message: unknown,
): message is { type: typeof OBSERVE_SELECTED_TAB_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === OBSERVE_SELECTED_TAB_MESSAGE
  );
}

export function isBrowserActionMessage(message: unknown): message is { type: typeof BROWSER_ACTION_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === BROWSER_ACTION_MESSAGE
  );
}

export function isBrowserActionCancelMessage(message: unknown): message is { type: typeof BROWSER_ACTION_CANCEL_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === BROWSER_ACTION_CANCEL_MESSAGE
  );
}

export async function handleBrowserRuntimeMessage(
  message: unknown,
  runtime: BrowserRuntime,
): Promise<AttachResult | ObservationResult | BrowserActionResult | BrowserActionCancelReply | null> {
  if (isAttachActiveTabMessage(message)) {
    return runtime.useActiveTab();
  }
  if (isObserveSelectedTabMessage(message)) {
    return runtime.observe();
  }
  if (isBrowserActionCancelMessage(message)) {
    const parsed = parseBrowserCancelMessage(message);
    if (!parsed.ok) {
      return { ok: false, actionId: null, error: parsed.error };
    }
    return runtime.cancelAction(parsed.actionId);
  }
  if (isBrowserActionMessage(message)) {
    const parsed = parseBrowserActionMessage(message);
    if (!parsed.ok) {
      return { ok: false, action: parsed.action, tabId: null, error: parsed.error };
    }
    const tabId = resolveActionTabId(parsed.request, runtime.selectedTabId);
    if (tabId === null) {
      return {
        ok: false,
        action: parsed.request.action,
        tabId: null,
        error: { code: "selected_tab_unavailable", message: "No selected live connection" },
      };
    }
    const scheduled = runtime.scheduleAction({ request: parsed.request, tabId });
    if (!scheduled.ok) {
      return { ok: false, action: scheduled.action, tabId, error: scheduled.error };
    }
    return scheduled.settled;
  }
  return null;
}

// Wraps a plain action runtime with per-tab action scheduling. Test fakes and
// embedders use this to get queueing and cancellation in one call.
export function attachTabActionCoordinator(
  base: Omit<BrowserRuntime, "scheduleAction" | "cancelAction">,
): BrowserRuntime {
  const coordinator = new TabActionCoordinator();
  return {
    ...base,
    scheduleAction: ({ request, tabId }) => enqueueActionRequest(coordinator, request, tabId, base),
    cancelAction: (id) => coordinator.cancel(id),
  };
}
