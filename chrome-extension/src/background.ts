import { BrowserContext } from "./browser/context";
import {
  handleBrowserRuntimeMessage,
  isAttachActiveTabMessage,
  isBrowserActionCancelMessage,
  isBrowserActionMessage,
  isObserveSelectedTabMessage,
} from "./browser/runtime";

export const browserContext = new BrowserContext({
  diagnostics: (event) => console.info("browser", event),
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    !isAttachActiveTabMessage(message) &&
    !isObserveSelectedTabMessage(message) &&
    !isBrowserActionMessage(message) &&
    !isBrowserActionCancelMessage(message)
  ) {
    return false;
  }
  void handleBrowserRuntimeMessage(message, browserContext).then(sendResponse);
  return true;
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to enable panel on action click:", error));
