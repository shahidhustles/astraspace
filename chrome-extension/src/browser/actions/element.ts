import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { isDisabled } from "../observation/extract";
import type { GroundedTarget, TargetResolutionResult } from "../types";
import { registerNewTabDetector } from "./new-tab";
import type { BrowserActionError, ClickResult } from "./types";

export interface ClickDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  onCreated: (listener: (tab: chrome.tabs.Tab) => void) => () => void;
  invalidate: () => void;
  currentUrl: () => string;
}

export type ElementPrepResult = { ok: true } | { ok: false; error: BrowserActionError };

export async function prepareElementForInteraction(
  element: ElementHandle<Element>,
): Promise<ElementPrepResult> {
  if (await element.evaluate(isDisabled)) {
    return { ok: false, error: { code: "disabled_target", message: "Element is disabled" } };
  }
  if (await element.isHidden()) {
    return { ok: false, error: { code: "not_interactable", message: "Element is not visible" } };
  }
  await element.scrollIntoView();
  return { ok: true };
}

export async function clickGroundedTarget(target: GroundedTarget, deps: ClickDeps): Promise<ClickResult> {
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    if (await isFileInput(element)) {
      return { ok: false, error: { code: "file_upload_required", message: "File upload is not supported" } };
    }
    const prepared = await prepareElementForInteraction(element);
    if (!prepared.ok) {
      return prepared;
    }
    const detector = registerNewTabDetector(deps.onCreated);
    try {
      deps.invalidate();
      await element.click();
      return { ok: true, url: deps.currentUrl(), newTabId: detector.observedTabId() };
    } finally {
      detector.stop();
    }
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

function isFileInput(element: ElementHandle<Element>): Promise<boolean> {
  return element.evaluate((node) => node instanceof HTMLInputElement && node.type === "file");
}