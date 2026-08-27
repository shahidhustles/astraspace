import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { isDisabled } from "../observation/extract";
import type { GroundedTarget, TargetResolutionResult } from "../types";
import type { BrowserActionError, ClickCapture, ClickResult } from "./types";

export interface ClickDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  // Armed before the snapshot invalidates. After the click resolves it runs
  // the bounded settlement barrier and returns captured evidence, or null
  // when nothing was armed.
  settle?: () => Promise<ClickCapture | null>;
  // Cleans up anything the settlement armed even when the click never fired.
  finishActivation?: () => void;
  invalidate: () => void;
  currentUrl: () => string;
}

export type ElementPrepResult = { ok: true } | { ok: false; error: BrowserActionError };

export function isHitTestTarget(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view || view.getComputedStyle(el).pointerEvents === "none") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const right = Math.min(view.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(view.innerHeight, rect.bottom);
  if (right <= left || bottom <= top) {
    return false;
  }
  const x = left + (right - left) / 2;
  const y = top + (bottom - top) / 2;
  let hit = el.ownerDocument.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const nested = hit.shadowRoot.elementFromPoint(x, y);
    if (!nested || nested === hit) {
      break;
    }
    hit = nested;
  }
  return hit === el || (hit !== null && el.contains(hit));
}

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
    if (!(await element.evaluate(isHitTestTarget))) {
      return {
        ok: false,
        error: { code: "not_interactable", message: "Element is covered or cannot receive pointer events" },
      };
    }
    deps.invalidate();
    await element.click();
    const captured = (await deps.settle?.()) ?? null;
    if (captured && !captured.ok) {
      return captured;
    }
    // A settle-less click keeps its historical result shape: measurement only
    // appears when the barrier actually measured something.
    const measured = captured && captured.ok ? captured.measurement : undefined;
    const hasMeasurement = measured !== undefined && Object.keys(measured).length > 0;
    return {
      ok: true,
      url: captured && captured.ok && captured.finalUrl ? captured.finalUrl : deps.currentUrl(),
      newTabId: captured && captured.ok ? captured.newTabId : null,
      ...(hasMeasurement && measured ? { measurement: measured } : {}),
    };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    deps.finishActivation?.();
    await element.dispose().catch(() => {});
  }
}

function isFileInput(element: ElementHandle<Element>): Promise<boolean> {
  return element.evaluate((node) => node instanceof HTMLInputElement && node.type === "file");
}
