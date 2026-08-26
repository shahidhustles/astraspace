import type {
  ElementHandle,
  Keyboard,
  KeyInput,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { GroundedTarget, TargetResolutionResult } from "../types";
import { prepareElementForInteraction } from "./element";
import type { KeypressInput, KeypressModifiers, KeypressResult } from "./types";

export interface KeypressDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  invalidate: () => void;
  keyboard: () => Keyboard | null;
  currentUrl: () => string;
}

const KEY_ALIASES: Record<string, KeyInput> = {
  escape: "Escape",
  esc: "Escape",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  space: "Space",
  " ": "Space",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  arrowleft: "ArrowLeft",
  left: "ArrowLeft",
  arrowright: "ArrowRight",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  up: "ArrowUp",
  arrowdown: "ArrowDown",
  down: "ArrowDown",
  shift: "Shift",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  meta: "Meta",
};

const MODIFIER_ORDER = ["alt", "control", "meta", "shift"] as const;

const MODIFIER_KEYS: Record<keyof KeypressModifiers, KeyInput> = {
  alt: "Alt",
  control: "Control",
  meta: "Meta",
  shift: "Shift",
};

export async function keypressGroundedTarget(input: KeypressInput, deps: KeypressDeps): Promise<KeypressResult> {
  const keyboard = deps.keyboard();
  if (!keyboard) {
    return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
  }
  let element: ElementHandle<Element> | null = null;
  try {
    if (input.target) {
      const resolved = await deps.resolveTarget(input.target);
      if (!resolved.ok) {
        return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
      }
      element = resolved.element;
      const prepared = await prepareElementForInteraction(element);
      if (!prepared.ok) {
        return prepared;
      }
      await element.focus();
    }
    deps.invalidate();
    for (const modifier of orderedModifiers(input.modifiers)) {
      await keyboard.down(modifier);
    }
    await keyboard.press(toKeyInput(input.key));
    return { ok: true, url: deps.currentUrl() };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    for (const modifier of orderedModifiers(input.modifiers).reverse()) {
      try {
        await keyboard.up(modifier);
      } catch {
        // Release failure must not replace the main result.
      }
    }
    await element?.dispose().catch(() => {});
  }
}

function orderedModifiers(modifiers: KeypressModifiers): KeyInput[] {
  return MODIFIER_ORDER.filter((name) => modifiers[name]).map((name) => MODIFIER_KEYS[name]);
}

function toKeyInput(key: string): KeyInput {
  const normalized = key.trim().toLowerCase();
  return KEY_ALIASES[normalized] ?? (key as KeyInput);
}