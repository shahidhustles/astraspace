// Service worker for the Astra side panel extension.
//
// The browser-control runtime now lives in packages/browser-mcp/extension-runtime/
// (a separate, loadable extension). This worker only manages the side panel.

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Failed to enable panel on action click:", error));
