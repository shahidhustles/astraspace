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

function invalid(action: BrowserActionName | null, message: string): BrowserActionParseResult {
  return { ok: false, action, error: { code: "invalid_action", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}