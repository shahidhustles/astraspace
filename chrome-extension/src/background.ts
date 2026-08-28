import { BrowserContext } from "./browser/context";
import { BrowserControlBridge } from "./browser/bridge";
import {
  dispatchBrowserWorkRequest,
  handleBrowserRuntimeMessage,
  isAttachActiveTabMessage,
  isBrowserActionCancelMessage,
  isBrowserActionMessage,
  isObserveSelectedTabMessage,
} from "./browser/runtime";
import { isEveSessionChangedMessage } from "./lib/eve-browser-session";

export const browserContext = new BrowserContext({
  diagnostics: (event) => console.info("browser", event),
});

export const browserControlBridge = new BrowserControlBridge();

browserControlBridge.setDispatcher((request) =>
  dispatchBrowserWorkRequest(request, browserContext),
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isEveSessionChangedMessage(message)) {
    void browserControlBridge
      .bind(message.sessionId)
      .then((bound) => {
        if (!bound) console.info("browser-control bind failed", message.sessionId);
      })
      .catch((error) => console.info("browser-control bind error", error));
    return false;
  }
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

void browserControlBridge.resumeFromStorage().catch((error) => {
  console.info("browser-control resume failed", error);
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to enable panel on action click:", error));
