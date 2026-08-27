import { describe, expect, test } from "bun:test";
import type { ElementHandle, KeyInput } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { isFocusedElement, keypressGroundedTarget, type KeypressDeps } from "../src/browser/actions/keyboard";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { isDisabled } from "../src/browser/observation/extract";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};


// Dispatched envelopes carry completion evidence whose id and timing vary.
const completes = (status: string) => ({
  actionId: expect.any(String),
  status,
  elapsedMs: expect.any(Number),
});

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return attachTabActionCoordinator({
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    click: async () => ({ ok: true, url: "https://example.com", newTabId: null }),
    type: async () => ({ ok: true, url: "https://example.com" }),
    clearInput: async () => ({ ok: true, url: "https://example.com" }),
    keypress: async () => ({ ok: true, url: "https://example.com" }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  });
}

describe("browser_keypress dispatch", () => {
  test("sends a targeted keypress through the action contract", async () => {
    let received: unknown = null;
    const runtime = fakeRuntime({
      keypress: async (input) => {
        received = input;
        return { ok: true, url: "https://example.com/final" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_keypress",
        input: { key: "Enter", modifiers: { alt: false, control: true, meta: false, shift: false }, target: TARGET },
      },
      runtime,
    );

    expect(received).toEqual({
      key: "Enter",
      modifiers: { alt: false, control: true, meta: false, shift: false },
      target: TARGET,
    });
    expect(result).toEqual({
      ok: true,
      action: "browser_keypress",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "keypress" },
      completion: completes("completed"),
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("uses the selected tab for a focus-free keypress", async () => {
    let received: unknown = null;
    const runtime = fakeRuntime({
      keypress: async (input) => {
        received = input;
        return { ok: true, url: "https://example.com/final" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_keypress",
        input: { key: "a", modifiers: { alt: false, control: true, meta: false, shift: false } },
      },
      runtime,
    );

    expect(received).toEqual({
      key: "a",
      modifiers: { alt: false, control: true, meta: false, shift: false },
      target: null,
    });
    expect(result).toMatchObject({
      ok: true,
      action: "browser_keypress",
      tabId: 7,
      data: { kind: "keypress" },
    });
  });

  test("preserves grounded-target failures", async () => {
    const runtime = fakeRuntime({
      keypress: async () => ({ ok: false, error: { code: "stale_ref", message: "stale", target: TARGET } }),
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_keypress",
        input: { key: "Enter", modifiers: { alt: false, control: false, meta: false, shift: false }, target: TARGET },
      },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_keypress",
      tabId: 7,
      error: { code: "stale_ref", message: "stale", target: TARGET },
      completion: completes("failed"),
    });
  });

  test("returns selected_tab_unavailable for a focus-free keypress with no selected tab", async () => {
    const runtime = fakeRuntime({ selectedTabId: null });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_keypress",
        input: { key: "a", modifiers: { alt: false, control: false, meta: false, shift: false } },
      },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_keypress",
      tabId: null,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
  });

  test("returns action_failed when the keypress runtime throws", async () => {
    const runtime = fakeRuntime({
      keypress: async () => {
        throw new Error("boom");
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_keypress",
        input: { key: "a", modifiers: { alt: false, control: false, meta: false, shift: false } },
      },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_keypress",
      tabId: 7,
      error: { code: "action_failed", message: "Browser action failed" },
      completion: completes("failed"),
    });
  });

  test("rejects a malformed keypress request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { key: "", modifiers: {} },
      { key: "a", modifiers: { alt: "yes" } },
      { key: "a", modifiers: { super: true } },
      { key: "a", modifiers: [] },
      { key: "a", modifiers: {}, target: { ...TARGET, ref: 0 } },
      { key: "a", modifiers: {}, extra: true },
      { key: "ab", modifiers: { alt: false, control: false, meta: false, shift: false } },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_keypress", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_keypress",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_keypress") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("keypressGroundedTarget", () => {
  interface FakeKeyboardCalls {
    down: string[];
    up: string[];
    press: string[];
  }

  interface FakeHandleCalls {
    evaluate: boolean;
    isHidden: boolean;
    scrollIntoView: boolean;
    focus: boolean;
    dispose: boolean;
    disabled: boolean;
    focused: boolean;
  }

  function fakeKeyboard(calls: FakeKeyboardCalls, overrides: Record<string, unknown> = {}) {
    return {
      down: async (key: KeyInput) => {
        calls.down.push(key);
      },
      up: async (key: KeyInput) => {
        calls.up.push(key);
      },
      press: async (key: KeyInput) => {
        calls.press.push(key);
      },
      ...overrides,
    };
  }

  function fakeHandle(
    calls: FakeHandleCalls,
    overrides: Record<string, unknown> = {},
  ): ElementHandle<Element> {
    return {
      evaluate: async (fn: (node: Element) => unknown) => {
        calls.evaluate = true;
        if (fn === isDisabled) {
          return calls.disabled;
        }
        if (fn === isFocusedElement) {
          return calls.focused;
        }
        return false;
      },
      isHidden: async () => {
        calls.isHidden = true;
        return false;
      },
      scrollIntoView: async () => {
        calls.scrollIntoView = true;
      },
      focus: async () => {
        calls.focus = true;
      },
      dispose: async () => {
        calls.dispose = true;
      },
      ...overrides,
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<KeypressDeps> = {}): {
    keyboardCalls: FakeKeyboardCalls;
    log: string[];
    deps: KeypressDeps;
  } {
    const keyboardCalls: FakeKeyboardCalls = { down: [], up: [], press: [] };
    const log: string[] = [];
    return {
      keyboardCalls,
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle(handleCalls()) };
        },
        invalidate: () => log.push("invalidate"),
        keyboard: () => fakeKeyboard(keyboardCalls),
        currentUrl: () => "https://example.com/final",
        ...overrides,
      },
    };
  }

  function handleCalls(): FakeHandleCalls {
    return {
      evaluate: false,
      isHidden: false,
      scrollIntoView: false,
      focus: false,
      dispose: false,
      disabled: false,
      focused: true,
    };
  }

  const NO_MODIFIERS = { alt: false, control: false, meta: false, shift: false };
  const ALL_MODIFIERS = { alt: true, control: true, meta: true, shift: true };

  test("focuses the target, presses modifiers in order, and releases them in reverse", async () => {
    const calls = handleCalls();
    const { keyboardCalls, log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return {
        ok: true,
        element: fakeHandle(calls, {
          focus: async () => {
            calls.focus = true;
            log.push("focus");
          },
        }),
      };
    };

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({ ok: true, url: "https://example.com/final" });
    expect(calls.evaluate).toBe(true);
    expect(calls.isHidden).toBe(true);
    expect(calls.scrollIntoView).toBe(true);
    expect(calls.focus).toBe(true);
    expect(log).toEqual(["resolve", "invalidate", "focus"]);
    expect(keyboardCalls.down).toEqual(["Alt", "Control", "Meta", "Shift"]);
    expect(keyboardCalls.press).toEqual(["a"]);
    expect(keyboardCalls.up).toEqual(["Shift", "Meta", "Control", "Alt"]);
    expect(calls.dispose).toBe(true);
  });

  test("releases only modifiers whose key-down completed", async () => {
    const { keyboardCalls, deps } = fakeDeps({
      keyboard: () =>
        fakeKeyboard(keyboardCalls, {
          down: async (key: KeyInput) => {
            if (key === "Control") {
              throw new Error("keyboard rejected modifier");
            }
            keyboardCalls.down.push(key);
          },
        }),
    });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(keyboardCalls.down).toEqual(["Alt"]);
    expect(keyboardCalls.up).toEqual(["Alt"]);
  });

  test("presses and releases only the declared modifiers", async () => {
    const { keyboardCalls, deps } = fakeDeps();

    await keypressGroundedTarget(
      { key: "Enter", modifiers: { alt: false, control: true, meta: false, shift: true }, target: TARGET },
      deps,
    );

    expect(keyboardCalls.down).toEqual(["Control", "Shift"]);
    expect(keyboardCalls.up).toEqual(["Shift", "Control"]);
  });

  test("presses the literal plus without splitting", async () => {
    const { keyboardCalls, deps } = fakeDeps();

    const result = await keypressGroundedTarget(
      { key: "+", modifiers: NO_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({ ok: true, url: "https://example.com/final" });
    expect(keyboardCalls.press).toEqual(["+"]);
    expect(keyboardCalls.up).toEqual([]);
  });

  test("aliases common special key names", async () => {
    const { keyboardCalls, deps } = fakeDeps();

    await keypressGroundedTarget(
      { key: "enter", modifiers: NO_MODIFIERS, target: TARGET },
      deps,
    );

    expect(keyboardCalls.press).toEqual(["Enter"]);
  });

  test("releases modifiers in reverse even when the main press fails", async () => {
    const calls = handleCalls();
    const { keyboardCalls, deps } = fakeDeps({
      keyboard: () =>
        fakeKeyboard(keyboardCalls, {
          press: async () => {
            throw new Error("detached");
          },
        }),
    });
    deps.resolveTarget = async () => ({ ok: true, element: fakeHandle(calls) });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(keyboardCalls.down).toEqual(["Alt", "Control", "Meta", "Shift"]);
    expect(keyboardCalls.up).toEqual(["Shift", "Meta", "Control", "Alt"]);
    expect(calls.dispose).toBe(true);
  });

  test("releases modifiers in reverse even when focusing fails", async () => {
    const calls = handleCalls();
    const { keyboardCalls, deps } = fakeDeps();
    deps.resolveTarget = async () => ({
      ok: true,
      element: fakeHandle(calls, {
        focus: async () => {
          throw new Error("detached");
        },
      }),
    });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(keyboardCalls.down).toEqual([]);
    expect(keyboardCalls.up).toEqual([]);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a target that did not become focused", async () => {
    const calls = { ...handleCalls(), focused: false };
    const { keyboardCalls, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: NO_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "not_interactable", message: "Element could not receive focus" },
    });
    expect(keyboardCalls.press).toEqual([]);
    expect(calls.dispose).toBe(true);
  });

  test("skips resolution and focusing for a focus-free keypress", async () => {
    const calls = handleCalls();
    const { keyboardCalls, log, deps } = fakeDeps();

    const result = await keypressGroundedTarget(
      { key: "Tab", modifiers: NO_MODIFIERS, target: null },
      deps,
    );

    expect(result).toEqual({ ok: true, url: "https://example.com/final" });
    expect(log).toEqual(["invalidate"]);
    expect(calls.focus).toBe(false);
    expect(calls.evaluate).toBe(false);
    expect(keyboardCalls.press).toEqual(["Tab"]);
  });

  test("touches nothing when resolution fails", async () => {
    const calls = handleCalls();
    const { keyboardCalls, log, deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: false,
        code: "stale_ref",
        target: TARGET,
        reason: "stale",
      }),
    });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "stale_ref", message: "stale", target: TARGET },
    });
    expect(log).toEqual([]);
    expect(keyboardCalls.down).toEqual([]);
    expect(keyboardCalls.up).toEqual([]);
    expect(calls.dispose).toBe(false);
  });

  test("returns selected_tab_unavailable without a keyboard", async () => {
    const { keyboardCalls, deps } = fakeDeps({ keyboard: () => null });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: NO_MODIFIERS, target: null },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "selected_tab_unavailable", message: "No selected live connection" },
    });
    expect(keyboardCalls.down).toEqual([]);
    expect(keyboardCalls.up).toEqual([]);
  });

  test("rejects a disabled target without pressing keys", async () => {
    const calls = { ...handleCalls(), disabled: true };
    const { keyboardCalls, log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await keypressGroundedTarget(
      { key: "a", modifiers: ALL_MODIFIERS, target: TARGET },
      deps,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "disabled_target", message: "Element is disabled" },
    });
    expect(log).toEqual([]);
    expect(keyboardCalls.down).toEqual([]);
    expect(keyboardCalls.up).toEqual([]);
    expect(calls.dispose).toBe(true);
  });
});
