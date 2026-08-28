import { BrowserContext } from "./browser/context";
import { BrowserControlBridge } from "./browser/bridge";
import { BrowserMutationLedger } from "./browser/bridge-ledger";
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
const browserMutationLedger = new BrowserMutationLedger();

async function attachActiveTabForBrowserControl(): Promise<void> {
  const result = await browserContext.useActiveTab();
  if (!result.ok) {
    console.info("browser-control active-tab attach failed", result.error.code);
  }
}

browserControlBridge.setDispatcher((request) =>
  dispatchBrowserWorkRequest(request, browserContext, browserMutationLedger),
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isEveSessionChangedMessage(message)) {
    void browserControlBridge
      .bind(message.sessionId)
      .then((bound) => {
        if (!bound) console.info("browser-control bind failed", message.sessionId);
        if (bound) void attachActiveTabForBrowserControl();
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

void browserControlBridge
  .resumeFromStorage()
  .then((resumed) => {
    if (resumed) void attachActiveTabForBrowserControl();
  })
  .catch((error) => {
    console.info("browser-control resume failed", error);
  });

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to enable panel on action click:", error));
