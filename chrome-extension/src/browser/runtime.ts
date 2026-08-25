import type { AttachResult } from "./page";
import type { ObservationResult } from "./types";

export const ATTACH_ACTIVE_TAB_MESSAGE = "browser.attach-active-tab";
export const OBSERVE_SELECTED_TAB_MESSAGE = "browser.observe-selected-tab";

export interface BrowserRuntime {
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

export async function handleBrowserRuntimeMessage(
  message: unknown,
  runtime: BrowserRuntime,
): Promise<AttachResult | ObservationResult | null> {
  if (isAttachActiveTabMessage(message)) {
    return runtime.useActiveTab();
  }
  if (isObserveSelectedTabMessage(message)) {
    return runtime.observe();
  }
  return null;
}
