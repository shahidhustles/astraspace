import { dispatchBrowserAction, type BrowserActionRuntime } from "./actions/dispatcher";
import { BROWSER_ACTION_MESSAGE, type BrowserActionResult } from "./actions/types";
import { parseBrowserActionMessage } from "./actions/validation";
import type { AttachResult } from "./page";
import type { ObservationResult } from "./types";

export const ATTACH_ACTIVE_TAB_MESSAGE = "browser.attach-active-tab";
export const OBSERVE_SELECTED_TAB_MESSAGE = "browser.observe-selected-tab";

export interface BrowserRuntime extends BrowserActionRuntime {
  useActiveTab: () => Promise<AttachResult>;
  observe: () => Promise<ObservationResult>;
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

export async function handleBrowserRuntimeMessage(
  message: unknown,
  runtime: BrowserRuntime,
): Promise<AttachResult | ObservationResult | BrowserActionResult | null> {
  if (isAttachActiveTabMessage(message)) {
    return runtime.useActiveTab();
  }
  if (isObserveSelectedTabMessage(message)) {
    return runtime.observe();
  }
  if (isBrowserActionMessage(message)) {
    const parsed = parseBrowserActionMessage(message);
    if (!parsed.ok) {
      return { ok: false, action: parsed.action, tabId: null, error: parsed.error };
    }
    return dispatchBrowserAction(parsed.request, runtime);
  }
  return null;
}
