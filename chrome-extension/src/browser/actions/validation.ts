import type { GroundedTarget, SnapshotId } from "../types";
import {
  BROWSER_ACTION_MESSAGE,
  type BrowserActionName,
  type BrowserActionRequest,
  type BrowserScrollMode,
  type InvalidActionError,
  type KeypressInput,
  type KeypressModifiers,
} from "./types";

export type BrowserActionParseResult =
  | { ok: true; request: BrowserActionRequest }
  | { ok: false; action: BrowserActionName | null; error: InvalidActionError };

export function parseBrowserActionMessage(message: unknown): BrowserActionParseResult {
  if (!isRecord(message)) {
    return invalid(null, "Browser action message must be an object");
  }
  if (message.type !== BROWSER_ACTION_MESSAGE) {
    return invalid(null, "Not a browser action message");
  }
  if (typeof message.action !== "string") {
    return invalid(null, "Missing action name");
  }
  if (!hasOnlyKeys(message, ["type", "action", "input"])) {
    return invalid(null, "Browser action request has unknown fields");
  }

  switch (message.action) {
    case "browser_navigate": {
      const input = message.input;
      if (!isRecord(input)) {
        return invalid("browser_navigate", "browser_navigate requires an input object");
      }
      if (!hasOnlyKeys(input, ["url"])) {
        return invalid("browser_navigate", "browser_navigate input has unknown fields");
      }
      if (typeof input.url !== "string") {
        return invalid("browser_navigate", "browser_navigate requires a string url");
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: input.url } },
      };
    }
    case "browser_back": {
      return parseNoInputRequest(message, "browser_back");
    }
    case "browser_refresh": {
      return parseNoInputRequest(message, "browser_refresh");
    }
    case "browser_click": {
      const target = parseGroundedTarget(message.input, "browser_click");
      if (!target.ok) {
        return invalid("browser_click", target.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: target.target },
      };
    }
    case "browser_type": {
      const input = message.input;
      if (!isRecord(input)) {
        return invalid("browser_type", "browser_type requires an input object");
      }
      if (!hasOnlyKeys(input, ["target", "text"])) {
        return invalid("browser_type", "browser_type input has unknown fields");
      }
      const target = parseGroundedTarget(input.target, "browser_type");
      if (!target.ok) {
        return invalid("browser_type", target.message);
      }
      if (typeof input.text !== "string" || input.text.length === 0) {
        return invalid("browser_type", "browser_type requires a non-empty string text");
      }
      return {
        ok: true,
        request: {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_type",
          input: { target: target.target, text: input.text },
        },
      };
    }
    case "browser_clear_input": {
      const target = parseGroundedTarget(message.input, "browser_clear_input");
      if (!target.ok) {
        return invalid("browser_clear_input", target.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: target.target },
      };
    }
    case "browser_keypress": {
      const parsed = parseKeypressInput(message.input);
      if (!parsed.ok) {
        return invalid("browser_keypress", parsed.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_keypress", input: parsed.input },
      };
    }
    case "browser_scroll": {
      const parsed = parseScrollInput(message.input);
      if (!parsed.ok) {
        return invalid("browser_scroll", parsed.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll", input: parsed.input },
      };
    }
    case "browser_scroll_to_text": {
      const parsed = parseScrollToTextInput(message.input);
      if (!parsed.ok) {
        return invalid("browser_scroll_to_text", parsed.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_scroll_to_text", input: parsed.input },
      };
    }
    case "browser_get_select_options": {
      const target = parseGroundedTarget(message.input, "browser_get_select_options");
      if (!target.ok) {
        return invalid("browser_get_select_options", target.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: target.target },
      };
    }
    case "browser_select_option": {
      const parsed = parseSelectOptionInput(message.input);
      if (!parsed.ok) {
        return invalid("browser_select_option", parsed.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_select_option", input: parsed.input },
      };
    }
    case "browser_open_tab": {
      const url = parseUrlInput(message, "browser_open_tab");
      if (!url.ok) {
        return invalid("browser_open_tab", url.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_open_tab", input: { url: url.url } },
      };
    }
    case "browser_switch_tab": {
      const tabId = parseTabId(message.input, "browser_switch_tab");
      if (!tabId.ok) {
        return invalid("browser_switch_tab", tabId.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_switch_tab", input: { tabId: tabId.tabId } },
      };
    }
    case "browser_close_tab": {
      const tabId = parseTabId(message.input, "browser_close_tab");
      if (!tabId.ok) {
        return invalid("browser_close_tab", tabId.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_close_tab", input: { tabId: tabId.tabId } },
      };
    }
    default:
      return invalid(null, `Unknown browser action: ${message.action}`);
  }
}

function parseNoInputRequest(
  message: Record<string, unknown>,
  action: "browser_back" | "browser_refresh",
): BrowserActionParseResult {
  if (!isRecord(message.input)) {
    return invalid(action, `${action} requires an input object`);
  }
  if (Object.keys(message.input).length > 0) {
    return invalid(action, `${action} takes no input`);
  }
  return {
    ok: true,
    request: { type: BROWSER_ACTION_MESSAGE, action, input: {} },
  };
}

function parseGroundedTarget(
  input: unknown,
  action:
    | "browser_click"
    | "browser_type"
    | "browser_clear_input"
    | "browser_keypress"
    | "browser_scroll"
    | "browser_get_select_options"
    | "browser_select_option",
): { ok: true; target: GroundedTarget } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: `${action} requires an input object` };
  }
  if (!hasOnlyKeys(input, ["tabId", "snapshotId", "ref"])) {
    return { ok: false, message: `${action} input has unknown fields` };
  }
  if (typeof input.tabId !== "number" || !Number.isInteger(input.tabId)) {
    return { ok: false, message: `${action} requires an integer tabId` };
  }
  if (input.tabId < 0) {
    return { ok: false, message: `${action} requires a non-negative tabId` };
  }
  if (typeof input.snapshotId !== "string" || input.snapshotId.length === 0) {
    return { ok: false, message: `${action} requires a string snapshotId` };
  }
  if (typeof input.ref !== "number" || !Number.isInteger(input.ref) || input.ref <= 0) {
    return { ok: false, message: `${action} requires a positive integer ref` };
  }
  return {
    ok: true,
    target: {
      tabId: input.tabId,
      snapshotId: input.snapshotId as SnapshotId,
      ref: input.ref,
    },
  };
}

function parseKeypressInput(
  input: unknown,
): { ok: true; input: KeypressInput } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_keypress requires an input object" };
  }
  if (!hasOnlyKeys(input, ["key", "modifiers", "target"])) {
    return { ok: false, message: "browser_keypress input has unknown fields" };
  }
  if (typeof input.key !== "string" || !isSupportedKey(input.key)) {
    return { ok: false, message: "browser_keypress requires one supported key" };
  }
  const modifiers = parseKeypressModifiers(input.modifiers);
  if (!modifiers.ok) {
    return modifiers;
  }
  if (input.target === undefined) {
    return { ok: true, input: { key: input.key, modifiers: modifiers.modifiers, target: null } };
  }
  const target = parseGroundedTarget(input.target, "browser_keypress");
  if (!target.ok) {
    return { ok: false, message: target.message };
  }
  return {
    ok: true,
    input: { key: input.key, modifiers: modifiers.modifiers, target: target.target },
  };
}

function parseKeypressModifiers(
  input: unknown,
): { ok: true; modifiers: KeypressModifiers } | { ok: false; message: string } {
  if (input === undefined) {
    return { ok: true, modifiers: { alt: false, control: false, meta: false, shift: false } };
  }
  if (!isRecord(input)) {
    return { ok: false, message: "browser_keypress modifiers must be an object" };
  }
  if (!hasOnlyKeys(input, ["alt", "control", "meta", "shift"])) {
    return { ok: false, message: "browser_keypress modifiers has unknown fields" };
  }
  for (const name of ["alt", "control", "meta", "shift"] as const) {
    if (typeof input[name] !== "boolean") {
      return { ok: false, message: `browser_keypress modifier ${name} must be a boolean` };
    }
  }
  return {
    ok: true,
    modifiers: {
      alt: input.alt as boolean,
      control: input.control as boolean,
      meta: input.meta as boolean,
      shift: input.shift as boolean,
    },
  };
}

function parseScrollInput(
  input: unknown,
): { ok: true; input: { mode: BrowserScrollMode; target?: GroundedTarget } } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_scroll requires an input object" };
  }
  if (!hasOnlyKeys(input, ["mode", "target"])) {
    return { ok: false, message: "browser_scroll input has unknown fields" };
  }
  const mode = parseScrollMode(input.mode);
  if (!mode.ok) {
    return { ok: false, message: mode.message };
  }
  if (input.target === undefined) {
    return { ok: true, input: { mode: mode.mode } };
  }
  const target = parseGroundedTarget(input.target, "browser_scroll");
  if (!target.ok) {
    return { ok: false, message: target.message };
  }
  return { ok: true, input: { mode: mode.mode, target: target.target } };
}

function parseScrollMode(
  input: unknown,
): { ok: true; mode: BrowserScrollMode } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_scroll requires a mode object" };
  }
  if (!hasOnlyKeys(input, ["mode", "percent"])) {
    return { ok: false, message: "browser_scroll mode has unknown fields" };
  }
  const mode = input.mode;
  if (mode === "page_up" || mode === "page_down" || mode === "top" || mode === "bottom") {
    if (input.percent !== undefined) {
      return { ok: false, message: `browser_scroll mode ${mode} takes no percent` };
    }
    return { ok: true, mode: { mode } };
  }
  if (mode === "percent") {
    const percent = input.percent;
    if (typeof percent !== "number" || !Number.isInteger(percent) || percent < 0 || percent > 100) {
      return { ok: false, message: "browser_scroll percent mode requires an integer percent from 0 through 100" };
    }
    return { ok: true, mode: { mode: "percent", percent } };
  }
  return { ok: false, message: `Unknown browser_scroll mode: ${String(mode)}` };
}

function parseScrollToTextInput(
  input: unknown,
): { ok: true; input: { text: string; occurrence: number } } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_scroll_to_text requires an input object" };
  }
  if (!hasOnlyKeys(input, ["text", "occurrence"])) {
    return { ok: false, message: "browser_scroll_to_text input has unknown fields" };
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    return { ok: false, message: "browser_scroll_to_text requires a non-empty string text" };
  }
  if (input.occurrence === undefined) {
    return { ok: true, input: { text: input.text, occurrence: 1 } };
  }
  if (typeof input.occurrence !== "number" || !Number.isInteger(input.occurrence) || input.occurrence <= 0) {
    return { ok: false, message: "browser_scroll_to_text requires a positive integer occurrence" };
  }
  return { ok: true, input: { text: input.text, occurrence: input.occurrence } };
}

function parseSelectOptionInput(
  input: unknown,
): { ok: true; input: { target: GroundedTarget; index: number; label: string; value: string } } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_select_option requires an input object" };
  }
  if (!hasOnlyKeys(input, ["target", "index", "label", "value"])) {
    return { ok: false, message: "browser_select_option input has unknown fields" };
  }
  const target = parseGroundedTarget(input.target, "browser_select_option");
  if (!target.ok) {
    return { ok: false, message: target.message };
  }
  if (typeof input.index !== "number" || !Number.isInteger(input.index) || input.index < 0) {
    return { ok: false, message: "browser_select_option requires a non-negative integer index" };
  }
  if (typeof input.label !== "string") {
    return { ok: false, message: "browser_select_option requires a string label" };
  }
  if (typeof input.value !== "string") {
    return { ok: false, message: "browser_select_option requires a string value" };
  }
  return {
    ok: true,
    input: { target: target.target, index: input.index, label: input.label, value: input.value },
  };
}

function parseUrlInput(
  message: Record<string, unknown>,
  action: "browser_open_tab",
): { ok: true; url: string } | { ok: false; message: string } {
  const input = message.input;
  if (!isRecord(input)) {
    return { ok: false, message: `${action} requires an input object` };
  }
  if (!hasOnlyKeys(input, ["url"])) {
    return { ok: false, message: `${action} input has unknown fields` };
  }
  if (typeof input.url !== "string") {
    return { ok: false, message: `${action} requires a string url` };
  }
  return { ok: true, url: input.url };
}

function parseTabId(
  input: unknown,
  action: "browser_switch_tab" | "browser_close_tab",
): { ok: true; tabId: number } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: `${action} requires an input object` };
  }
  if (!hasOnlyKeys(input, ["tabId"])) {
    return { ok: false, message: `${action} input has unknown fields` };
  }
  if (typeof input.tabId !== "number" || !Number.isInteger(input.tabId)) {
    return { ok: false, message: `${action} requires an integer tabId` };
  }
  if (input.tabId < 0) {
    return { ok: false, message: `${action} requires a non-negative tabId` };
  }
  return { ok: true, tabId: input.tabId };
}

function invalid(action: BrowserActionName | null, message: string): BrowserActionParseResult {
  return { ok: false, action, error: { code: "invalid_action", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

const SUPPORTED_NAMED_KEYS = new Set([
  "alt",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowup",
  "backspace",
  "control",
  "ctrl",
  "del",
  "delete",
  "down",
  "end",
  "enter",
  "esc",
  "escape",
  "home",
  "insert",
  "left",
  "meta",
  "pagedown",
  "pageup",
  "return",
  "right",
  "shift",
  "space",
  "tab",
  "up",
]);

function isSupportedKey(key: string): boolean {
  if (key.length === 1) {
    return true;
  }
  const normalized = key.trim().toLowerCase();
  return SUPPORTED_NAMED_KEYS.has(normalized) || /^f(?:[1-9]|1[0-2])$/.test(normalized);
}
