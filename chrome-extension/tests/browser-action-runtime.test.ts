import { describe, expect, test } from "bun:test";
import type { BrowserActionRequest } from "../src/browser/actions/types";
import { BROWSER_ACTION_CANCEL_MESSAGE, BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { parseBrowserActionMessage } from "../src/browser/actions/validation";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function clickTarget(tabId: number) {
  return { tabId, snapshotId: "snap-1", ref: 1 };
}

function clickOnTab(tabId: number) {
  return actionMessage("browser_click", clickTarget(tabId));
}

// Dispatched envelopes carry completion evidence whose id and timing vary.
const completes = (status: string, dispatchStarted = true) => ({
  actionId: expect.any(String),
  status,
  elapsedMs: expect.any(Number),
  dispatchStarted,
});

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return attachTabActionCoordinator({
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: true, url: "https://example.com" }),
    goBack: async () => ({ ok: true, url: "https://example.com/previous" }),
    refresh: async () => ({ ok: true, url: "https://example.com" }),
    ...overrides,
  });
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
      completion: completes("completed"),
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
      completion: completes("completed"),
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
      completion: completes("completed"),
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
      completion: completes("failed"),
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
      completion: completes("failed"),
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
      completion: completes("failed"),
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

describe("per-tab action scheduling through the runtime", () => {
  test("two delayed actions for one tab dispatch in submission order", async () => {
    const calls: string[] = [];
    const firstGate = deferred<void>();
    const runtime = fakeRuntime({
      navigate: async (url) => {
        if (url === "https://first.example") {
          calls.push("first-started");
          await firstGate.promise;
          calls.push("first-done");
        } else {
          calls.push("second-started");
        }
        return { ok: true, url };
      },
    });

    const first = handleBrowserRuntimeMessage(actionMessage("browser_navigate", { url: "https://first.example" }), runtime);
    const second = handleBrowserRuntimeMessage(
      actionMessage("browser_navigate", { url: "https://second.example" }),
      runtime,
    );

    await flush();
    expect(calls).toEqual(["first-started"]);

    firstGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true, action: "browser_navigate", url: "https://first.example" });
    expect(secondResult).toMatchObject({ ok: true, action: "browser_navigate", url: "https://second.example" });
    expect(calls).toEqual(["first-started", "first-done", "second-started"]);
  });

  test("delayed actions for separate tabs overlap", async () => {
    const gate = deferred<void>();
    let tab9Done = false;
    const runtime = fakeRuntime({
      click: async (target) => {
        if (target.tabId === 7) {
          await gate.promise;
          return { ok: true as const, url: "https://example.com/7", newTabId: null };
        }
        tab9Done = true;
        return { ok: true as const, url: "https://example.com/9", newTabId: null };
      },
    });
    const clickOn = (tabId: number) =>
      actionMessage("browser_click", { tabId, snapshotId: "snap-1", ref: 1 } satisfies BrowserActionRequest extends never
        ? never
        : { tabId, snapshotId: "snap-1", ref: 1 });

    const onTab7 = handleBrowserRuntimeMessage(clickOnTab(7), runtime);
    const onTab9 = handleBrowserRuntimeMessage(clickOnTab(9), runtime);

    const tab9Result = await onTab9;
    expect(tab9Done).toBe(true);
    expect(tab9Result).toMatchObject({ ok: true, tabId: 9 });

    gate.resolve();
    await onTab7;
  });

  test("cancelling a queued action returns action_cancelled and skips dispatch", async () => {
    const gate = deferred<void>();
    const clickCalls: unknown[] = [];
    const runtime = fakeRuntime({
      click: async (target) => {
        clickCalls.push(target);
        await gate.promise;
        return { ok: true as const, url: "https://example.com", newTabId: null };
      },
    });

    const head = handleBrowserRuntimeMessage(clickOnTab(7), runtime);
    const queued = handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: clickTarget(7), actionId: "cancel-me" },
      runtime,
    );
    await flush();

    const cancelReply = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_CANCEL_MESSAGE, actionId: "cancel-me" },
      runtime,
    );
    expect(cancelReply).toMatchObject({
      ok: true,
      cancelled: true,
      dispatchStarted: false,
    });

    const queuedResult = await queued;
    expect(queuedResult).toEqual({
      ok: false,
      action: "browser_click",
      tabId: 7,
      error: {
        code: "action_cancelled",
        message: "Browser action was cancelled before dispatch",
        dispatchStarted: false,
      },
      completion: completes("cancelled", false),
    });
    expect(clickCalls.length).toBe(1);

    gate.resolve();
    await head;
  });

  test("a duplicate live id returns invalid_action", async () => {
    const gate = deferred<void>();
    const runtime = fakeRuntime({
      navigate: async () => {
        await gate.promise;
        return { ok: true, url: "https://example.com" };
      },
    });

    const first = handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://one.example" }, actionId: "dup" },
      runtime,
    );
    const duplicate = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://two.example" }, actionId: "dup" },
      runtime,
    );

    expect(duplicate).toEqual({
      ok: false,
      action: "browser_navigate",
      tabId: 7,
      error: { code: "invalid_action", message: 'actionId "dup" is already active' },
    });

    gate.resolve();
    await first;
  });

  test("malformed wait and actionId fields return invalid_action", async () => {
    const runtime = fakeRuntime();

    const badTimeout = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://x.example" }, wait: { timeoutMs: -5 } },
      runtime,
    );
    expect(badTimeout).toMatchObject({ ok: false, error: { code: "invalid_action" } });

    const hugeTimeout = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_back", input: {}, wait: { timeoutMs: 30_001 } },
      runtime,
    );
    expect(hugeTimeout).toMatchObject({
      ok: false,
      error: { code: "invalid_action", message: "wait requires an integer timeoutMs from 1 through 30000" },
    });

    const badExpectation = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_click",
        input: clickTarget(7),
        wait: { expectation: { intent: "somewhere", role: "button", name: "Submit" } },
      },
      runtime,
    );
    expect(badExpectation).toEqual({
      ok: false,
      action: "browser_click",
      tabId: null,
      error: { code: "invalid_action", message: 'wait expectation intent must be "appear" or "disappear"' },
    });

    const emptyExpectationRole = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_click",
        input: clickTarget(7),
        wait: { expectation: { intent: "appear", role: "", name: "Submit" } },
      },
      runtime,
    );
    expect(emptyExpectationRole).toMatchObject({ ok: false, error: { code: "invalid_action" } });

    const badActionId = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_refresh", input: {}, actionId: 42 },
      runtime,
    );
    expect(badActionId).toEqual({
      ok: false,
      action: "browser_refresh",
      tabId: null,
      error: { code: "invalid_action", message: "actionId must be a non-empty string" },
    });
  });

  test("valid wait input and a caller-supplied id flow through to success", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_navigate",
        input: { url: "https://example.com/waited" },
        actionId: "caller-id",
        wait: { timeoutMs: 5_000, expectation: { intent: "disappear", role: "progressbar", name: "Loading" } },
      },
      runtime,
    );
    expect(result).toMatchObject({ ok: true, action: "browser_navigate" });
  });

  test("cancelling an unknown id reports the miss without throwing", async () => {
    const runtime = fakeRuntime();
    const reply = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_CANCEL_MESSAGE, actionId: "ghost" },
      runtime,
    );
    expect(reply).toEqual({
      ok: false,
      actionId: "ghost",
      error: { code: "unknown_action_id", message: 'No active action with id "ghost"' },
    });
  });

  test("new result shapes survive JSON round-trip", async () => {
    const gate = deferred<void>();
    const runtime = fakeRuntime({
      navigate: async () => {
        await gate.promise;
        return { ok: true, url: "https://example.com" };
      },
    });
    const pending = handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_navigate", input: { url: "https://x.example" }, actionId: "rt" },
      runtime,
    );
    await flush();
    const reply = await handleBrowserRuntimeMessage({ type: BROWSER_ACTION_CANCEL_MESSAGE, actionId: "rt" }, runtime);
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);

    gate.resolve();
    const settled = await pending;
    expect(JSON.parse(JSON.stringify(settled))).toEqual(settled);
  });
});
