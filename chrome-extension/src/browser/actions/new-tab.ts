export interface NewTabDetector {
  stop: () => void;
  observedTabId: () => number | null;
}

export function registerNewTabDetector(
  sourceTabId: number,
  onCreated: (listener: (tab: chrome.tabs.Tab) => void) => () => void,
): NewTabDetector {
  let newTabId: number | null = null;
  const stop = onCreated((tab) => {
    if (newTabId === null && tab.id !== undefined && tab.openerTabId === sourceTabId) {
      newTabId = tab.id;
    }
  });
  return { stop, observedTabId: () => newTabId };
}
