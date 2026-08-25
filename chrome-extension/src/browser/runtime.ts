import type { AttachResult } from "./page";

export const ATTACH_ACTIVE_TAB_MESSAGE = "browser.attach-active-tab";

export interface ActiveTabRuntime {
  useActiveTab: () => Promise<AttachResult>;
}

export function isAttachActiveTabMessage(message: unknown): message is { type: typeof ATTACH_ACTIVE_TAB_MESSAGE } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === ATTACH_ACTIVE_TAB_MESSAGE
  );
}

export async function handleBrowserRuntimeMessage(
  message: unknown,
  runtime: ActiveTabRuntime,
): Promise<AttachResult | null> {
  if (!isAttachActiveTabMessage(message)) {
    return null;
  }
  return runtime.useActiveTab();
}
