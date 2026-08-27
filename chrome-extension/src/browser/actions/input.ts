import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { GroundedTarget, TargetResolutionResult } from "../types";
import type { ActionSettleSignals } from "../waits/types";
import { prepareElementForInteraction } from "./element";
import type { BrowserActionError, ClearInputResult, TypeResult } from "./types";

export interface InputDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  invalidate: () => void;
  currentUrl: () => string;
  // Runs after a successful edit; resolves null when no settlement was armed.
  settle?: () => Promise<ActionSettleSignals | null>;
}

export type EditabilityResult = { ok: true } | { ok: false; error: BrowserActionError };

export function isReadOnly(el: Element): boolean {
  if (el.getAttribute("aria-readonly")?.toLowerCase() === "true") {
    return true;
  }
  const view = el.ownerDocument.defaultView;
  if (!view) {
    return false;
  }
  if (el instanceof view.HTMLInputElement || el instanceof view.HTMLTextAreaElement) {
    return el.readOnly;
  }
  return false;
}

export function isEditableControl(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    return (
      !el.readOnly &&
      !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(
        el.type,
      )
    );
  }
  if (el instanceof HTMLTextAreaElement) {
    return !el.readOnly;
  }
  return (el as HTMLElement).isContentEditable === true;
}

export function clearEditableControl(el: Element): void {
  const view = el.ownerDocument.defaultView;
  if (view && el instanceof view.HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, "");
    } else {
      el.value = "";
    }
  } else if (view && el instanceof view.HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) {
      setter.call(el, "");
    } else {
      el.value = "";
    }
  } else {
    el.textContent = "";
  }
  const EventConstructor = view?.Event ?? Event;
  el.dispatchEvent(new EventConstructor("input", { bubbles: true }));
  el.dispatchEvent(new EventConstructor("change", { bubbles: true }));
}

export async function typeGroundedTarget(
  target: GroundedTarget,
  text: string,
  deps: InputDeps,
): Promise<TypeResult> {
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    const prepared = await prepareElementForInteraction(element);
    if (!prepared.ok) {
      return prepared;
    }
    const editable = await checkEditable(element);
    if (!editable.ok) {
      return editable;
    }
    deps.invalidate();
    await element.type(text);
    const signals = (await deps.settle?.()) ?? undefined;
    return { ok: true, url: deps.currentUrl(), ...(signals ? { signals } : {}) };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

export async function clearGroundedTarget(target: GroundedTarget, deps: InputDeps): Promise<ClearInputResult> {
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    const prepared = await prepareElementForInteraction(element);
    if (!prepared.ok) {
      return prepared;
    }
    const editable = await checkEditable(element);
    if (!editable.ok) {
      return editable;
    }
    deps.invalidate();
    await element.evaluate(clearEditableControl);
    const signals = (await deps.settle?.()) ?? undefined;
    return { ok: true, url: deps.currentUrl(), ...(signals ? { signals } : {}) };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

async function checkEditable(element: ElementHandle<Element>): Promise<EditabilityResult> {
  if (await element.evaluate(isReadOnly)) {
    return { ok: false, error: { code: "read_only_target", message: "Element is read-only" } };
  }
  if (!(await element.evaluate(isEditableControl))) {
    return { ok: false, error: { code: "not_interactable", message: "Element is not editable" } };
  }
  return { ok: true };
}
