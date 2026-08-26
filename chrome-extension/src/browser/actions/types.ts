import type { BrowserError } from "../types";

export const BROWSER_ACTION_MESSAGE = "browser.action";

export type BrowserActionName = "browser_navigate" | "browser_back" | "browser_refresh";

export type BrowserActionRequest =
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_navigate"; input: { url: string } }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_back"; input: Record<string, never> }
  | { type: typeof BROWSER_ACTION_MESSAGE; action: "browser_refresh"; input: Record<string, never> };

export type BrowserActionData =
  | { kind: "navigate" }
  | { kind: "back" }
  | { kind: "refresh" };

export interface InvalidActionError {
  code: "invalid_action";
  message: string;
}

export interface ActionFailedError {
  code: "action_failed";
  message: string;
}

export type BrowserActionError = BrowserError | InvalidActionError | ActionFailedError;

export type BrowserActionResult =
  | {
      ok: true;
      action: BrowserActionName;
      tabId: number;
      url: string;
      snapshotInvalidated: boolean;
      data: BrowserActionData;
    }
  | {
      ok: false;
      action: BrowserActionName | null;
      tabId: number | null;
      error: BrowserActionError;
    };