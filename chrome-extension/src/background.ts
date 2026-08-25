import { BrowserContext } from "./browser/context";

export const browserContext = new BrowserContext({
  diagnostics: (event) => console.log("browser", event),
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to enable panel on action click:", error));