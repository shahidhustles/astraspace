import type { GroundedTarget, SnapshotId } from "../types";
import {
  BROWSER_ACTION_MESSAGE,
  type BrowserActionName,
  type BrowserActionRequest,
  type InvalidActionError,
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
      const target = parseGroundedTarget(message.input);
      if (!target.ok) {
        return invalid("browser_click", target.message);
      }
      return {
        ok: true,
        request: { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: target.target },
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
): { ok: true; target: GroundedTarget } | { ok: false; message: string } {
  if (!isRecord(input)) {
    return { ok: false, message: "browser_click requires an input object" };
  }
  if (!hasOnlyKeys(input, ["tabId", "snapshotId", "ref"])) {
    return { ok: false, message: "browser_click input has unknown fields" };
  }
  if (typeof input.tabId !== "number" || !Number.isInteger(input.tabId)) {
    return { ok: false, message: "browser_click requires an integer tabId" };
  }
  if (typeof input.snapshotId !== "string" || input.snapshotId.length === 0) {
    return { ok: false, message: "browser_click requires a string snapshotId" };
  }
  if (typeof input.ref !== "number" || !Number.isInteger(input.ref) || input.ref <= 0) {
    return { ok: false, message: "browser_click requires a positive integer ref" };
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