import { describe, expect, test } from "bun:test";
import type { BrowserActionRequest } from "../src/browser/actions/types";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { parseBrowserActionMessage } from "../src/browser/actions/validation";
import { handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: true, url: "https://example.com" }),
    goBack: async () => ({ ok: true, url: "https://example.com/previous" }),
    refresh: async () => ({ ok: true, url: "https://example.com" }),
    ...overrides,
  };
}

function actionMessage(action: BrowserActionRequest["action"], input: BrowserActionRequest["input"]) {
  return { type: BROWSER_ACTION_MESSAGE, action, input };
}

describe("browser action runtime messages", () => {
  test("navigates the selected tab through the action contract", async () => {
    let receivedUrl: string | null = null;
    const runtime = fakeRuntime({
      navigate: async (url) => {
        receivedUrl = url;
        return { ok: true, url: "https://example.com/final" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      actionMessage("browser_navigate", { url: "https://example.com" }),
      runtime,
    );

    expect(receivedUrl).toBe("https://example.com");
    expect(result).toEqual({
      ok: true,
      action: "browser_navigate",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "navigate" },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("goes back through the action contract", async () => {
    let calls = 0;
    const runtime = fakeRuntime({
      goBack: async () => {
        calls += 1;
        return { ok: true, url: "https://example.com/previous" };
      },
    });

    const result = await handleBrowserRuntimeMessage(actionMessage("browser_back", {}), runtime);

    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: true,
      action: "browser_back",
      tabId: 7,
      url: "https://example.com/previous",
      snapshotInvalidated: true,
      data: { kind: "back" },
    });
  });

  test("refreshes the selected tab through the action contract", async () => {
    let calls = 0;
    const runtime = fakeRuntime({
      refresh: async () => {
        calls += 1;
        return { ok: true, url: "https://example.com" };
      },
    });

    const result = await handleBrowserRuntimeMessage(actionMessage("browser_refresh", {}), runtime);

    expect(calls).toBe(1);
    expect(result).toEqual({
      ok: true,
      action: "browser_refresh",
      tabId: 7,
      url: "https://example.com",
      snapshotInvalidated: true,
      data: { kind: "refresh" },
    });
  });

  test("preserves URL-policy errors with their specific code", async () => {
    const runtime = fakeRuntime({
      navigate: async () => ({
        ok: false,
        error: {
          code: "url_denied",
          message: "Blocked URL scheme: chrome-extension:",
          url: "chrome-extension://x",
        },
      }),
    });

    const result = await handleBrowserRuntimeMessage(
      actionMessage("browser_navigate", { url: "chrome-extension://x" }),
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: 7,
      error: {
        code: "url_denied",
        message: "Blocked URL scheme: chrome-extension:",
        url: "chrome-extension://x",
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("preserves lifecycle errors with their specific code", async () => {
    const runtime = fakeRuntime({
      navigate: async () => ({
        ok: false,
        error: { code: "navigation_timeout", message: "Navigation timed out" },
      }),
    });

    const result = await handleBrowserRuntimeMessage(
      actionMessage("browser_navigate", { url: "https://example.com" }),
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: 7,
      error: { code: "navigation_timeout", message: "Navigation timed out" },
    });
  });

  test("returns selected_tab_unavailable without running when no tab is selected", async () => {
    let navigateCalls = 0;
    const runtime = fakeRuntime({
      selectedTabId: null,
      navigate: async () => {
        navigateCalls += 1;
        return { ok: true, url: "https://example.com" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      actionMessage("browser_navigate", { url: "https://example.com" }),
      runtime,
    );

    expect(navigateCalls).toBe(0);
    expect(result).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("returns action_failed when the navigation runtime throws", async () => {
    const runtime = fakeRuntime({
      refresh: async () => {
        throw new Error("boom");
      },
    });

    const result = await handleBrowserRuntimeMessage(actionMessage("browser_refresh", {}), runtime);

    expect(result).toEqual({
      ok: false,
      action: "browser_refresh",
      tabId: 7,
      error: { code: "action_failed", message: "Browser action failed" },
    });
  });

  test("rejects an unknown action name with invalid_action", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_frobnicate", input: {} },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: null,
      tabId: null,
      error: { code: "invalid_action", message: "Unknown browser action: browser_frobnicate" },
    });
  });

  test("rejects a malformed navigate request with invalid_action", async () => {
    const runtime = fakeRuntime();

    const missingInput = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate" },
      runtime,
    );
    expect(missingInput).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: null,
      error: { code: "invalid_action", message: "browser_navigate requires an input object" },
    });

    const nonStringUrl = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: 42 } },
      runtime,
    );
    expect(nonStringUrl).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: null,
      error: { code: "invalid_action", message: "browser_navigate requires a string url" },
    });

    const extraInputKey = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://example.com", foo: 1 } },
      runtime,
    );
    expect(extraInputKey).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: null,
      error: { code: "invalid_action", message: "browser_navigate input has unknown fields" },
    });

    const extraRequestKey = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://example.com" }, foo: 1 },
      runtime,
    );
    expect(extraRequestKey).toEqual({
      ok: false,
      action: null,
      tabId: null,
      error: { code: "invalid_action", message: "Browser action request has unknown fields" },
    });
  });

  test("rejects back and refresh requests that carry input", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_back", input: { url: "https://example.com" } },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_back",
      tabId: null,
      error: { code: "invalid_action", message: "browser_back takes no input" },
    });
  });

  test("unrelated extension messages are ignored", async () => {
    const runtime = fakeRuntime();

    const result = await handleBrowserRuntimeMessage({ type: "unrelated" }, runtime);

    expect(result).toBeNull();
  });
});

describe("parseBrowserActionMessage", () => {
  test("rejects a non-object message with invalid_action", () => {
    expect(parseBrowserActionMessage("nope")).toEqual({
      ok: false,
      action: null,
      error: { code: "invalid_action", message: "Browser action message must be an object" },
    });
  });

  test("rejects a request without an action name", () => {
    expect(parseBrowserActionMessage({ type: BROWSER_ACTION_MESSAGE })).toEqual({
      ok: false,
      action: null,
      error: { code: "invalid_action", message: "Missing action name" },
    });
  });
});