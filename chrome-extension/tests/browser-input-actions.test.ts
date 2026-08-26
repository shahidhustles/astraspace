import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import {
  clearEditableControl,
  clearGroundedTarget,
  isEditableControl,
  isReadOnly,
  typeGroundedTarget,
  type InputDeps,
} from "../src/browser/actions/input";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { isDisabled } from "../src/browser/observation/extract";
import { handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return {
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
  };
}

describe("browser_type dispatch", () => {
  test("types into the grounded target through the action contract", async () => {
    let received: { target: GroundedTarget; text: string } | null = null;
    const runtime = fakeRuntime({
      type: async (target, text) => {
        received = { target, text };
        return { ok: true, url: "https://example.com/final" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input: { target: TARGET, text: "hello" } },
      runtime,
    );

    expect(received).toEqual({ target: TARGET, text: "hello" });
    expect(result).toEqual({
      ok: true,
      action: "browser_type",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "type" },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("preserves grounded-target and interaction failures", async () => {
    const failures = [
      { code: "stale_ref", message: "stale", target: TARGET },
      { code: "disabled_target", message: "Element is disabled" },
      { code: "read_only_target", message: "Element is read-only" },
      { code: "not_interactable", message: "Element is not editable" },
    ] as const;
    for (const error of failures) {
      const runtime = fakeRuntime({
        type: async () => ({ ok: false, error }),
      });
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input: { target: TARGET, text: "hello" } },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_type",
        tabId: 7,
        error,
      });
    }
  });

  test("rejects a malformed type request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { target: TARGET },
      { target: TARGET, text: "" },
      { target: TARGET, text: 5 },
      { target: { ...TARGET, ref: 0 }, text: "hello" },
      { target: TARGET, text: "hello", extra: true },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_type", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_type",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_type") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("browser_clear_input dispatch", () => {
  test("clears the grounded target through the action contract", async () => {
    let clearedTarget: GroundedTarget | null = null;
    const runtime = fakeRuntime({
      clearInput: async (target) => {
        clearedTarget = target;
        return { ok: true, url: "https://example.com/final" };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: TARGET },
      runtime,
    );

    expect(clearedTarget).toEqual(TARGET);
    expect(result).toEqual({
      ok: true,
      action: "browser_clear_input",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "clear_input" },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("preserves interaction failures with their specific code", async () => {
    const cases = [
      { code: "disabled_target", message: "Element is disabled" },
      { code: "read_only_target", message: "Element is read-only" },
      { code: "not_interactable", message: "Element is not editable" },
    ] as const;
    for (const error of cases) {
      const runtime = fakeRuntime({
        clearInput: async () => ({ ok: false, error }),
      });
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: TARGET },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_clear_input",
        tabId: 7,
        error,
      });
    }
  });

  test("rejects a malformed clear request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_clear_input", input: { tabId: 7, snapshotId: "s", ref: 2, extra: true } },
      runtime,
    );
    expect(result).toEqual({
      ok: false,
      action: "browser_clear_input",
      tabId: null,
      error: { code: "invalid_action", message: expect.stringContaining("browser_clear_input") },
    });
  });
});

describe("typeGroundedTarget", () => {
  interface FakeHandleCalls {
    evaluate: boolean;
    isHidden: boolean;
    scrollIntoView: boolean;
    type: boolean;
    dispose: boolean;
    disabled: boolean;
    readOnly: boolean;
    editable: boolean;
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
        if (fn === isReadOnly) {
          return calls.readOnly;
        }
        if (fn === isEditableControl) {
          return calls.editable;
        }
        return undefined;
      },
      isHidden: async () => {
        calls.isHidden = true;
        return false;
      },
      scrollIntoView: async () => {
        calls.scrollIntoView = true;
      },
      type: async () => {
        calls.type = true;
      },
      dispose: async () => {
        calls.dispose = true;
      },
      ...overrides,
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<InputDeps> = {}): { log: string[]; deps: InputDeps } {
    const log: string[] = [];
    return {
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle(handleCalls()) };
        },
        invalidate: () => log.push("invalidate"),
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
      type: false,
      dispose: false,
      disabled: false,
      readOnly: false,
      editable: true,
    };
  }

  test("resolves, validates, invalidates, types, and cleans up in order", async () => {
    const calls = handleCalls();
    let typedText: string | null = null;
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return {
        ok: true,
        element: fakeHandle(calls, {
          type: async (text: string) => {
            calls.type = true;
            typedText = text;
          },
        }),
      };
    };

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final" });
    expect(log).toEqual(["resolve", "invalidate"]);
    expect(typedText).toBe("hello");
    expect(calls.evaluate).toBe(true);
    expect(calls.isHidden).toBe(true);
    expect(calls.scrollIntoView).toBe(true);
    expect(calls.type).toBe(true);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a read-only target before invalidating or typing", async () => {
    const calls = { ...handleCalls(), readOnly: true };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "read_only_target", message: "Element is read-only" },
    });
    expect(log).toEqual([]);
    expect(calls.type).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a non-editable target before invalidating or typing", async () => {
    const calls = { ...handleCalls(), editable: false };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "not_interactable", message: "Element is not editable" },
    });
    expect(log).toEqual([]);
    expect(calls.type).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a disabled target without invalidating", async () => {
    const calls = { ...handleCalls(), disabled: true };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "disabled_target", message: "Element is disabled" },
    });
    expect(log).toEqual([]);
    expect(calls.type).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("touches nothing when resolution fails", async () => {
    const calls = handleCalls();
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: false,
        code: "stale_ref",
        target: TARGET,
        reason: "stale",
      }),
    });

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "stale_ref", message: "stale", target: TARGET },
    });
    expect(log).toEqual([]);
    expect(calls.dispose).toBe(false);
    expect(calls.evaluate).toBe(false);
  });

  test("disposes the handle when typing throws", async () => {
    const calls = handleCalls();
    const { deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: true,
        element: fakeHandle(calls, { type: async () => { throw new Error("detached"); } }),
      }),
    });

    const result = await typeGroundedTarget(TARGET, "hello", deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(calls.dispose).toBe(true);
  });
});

describe("clearGroundedTarget", () => {
  interface FakeHandleCalls {
    evaluate: boolean;
    isHidden: boolean;
    scrollIntoView: boolean;
    dispose: boolean;
    disabled: boolean;
    readOnly: boolean;
    editable: boolean;
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
        if (fn === isReadOnly) {
          return calls.readOnly;
        }
        if (fn === isEditableControl) {
          return calls.editable;
        }
        return undefined;
      },
      isHidden: async () => {
        calls.isHidden = true;
        return false;
      },
      scrollIntoView: async () => {
        calls.scrollIntoView = true;
      },
      dispose: async () => {
        calls.dispose = true;
      },
      ...overrides,
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<InputDeps> = {}): { log: string[]; deps: InputDeps } {
    const log: string[] = [];
    return {
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle(handleCalls()) };
        },
        invalidate: () => log.push("invalidate"),
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
      dispose: false,
      disabled: false,
      readOnly: false,
      editable: true,
    };
  }

  test("resolves, validates, invalidates, clears, and cleans up in order", async () => {
    const calls = handleCalls();
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls) };
    };

    const result = await clearGroundedTarget(TARGET, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final" });
    expect(log).toEqual(["resolve", "invalidate"]);
    expect(calls.evaluate).toBe(true);
    expect(calls.isHidden).toBe(true);
    expect(calls.scrollIntoView).toBe(true);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a read-only target before invalidating or clearing", async () => {
    const calls = { ...handleCalls(), readOnly: true };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await clearGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "read_only_target", message: "Element is read-only" },
    });
    expect(log).toEqual([]);
    expect(calls.dispose).toBe(true);
  });

  test("disposes the handle when the clear evaluation throws", async () => {
    const calls = handleCalls();
    const { deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: true,
        element: fakeHandle(calls, {
          evaluate: async () => {
            throw new Error("detached");
          },
        }),
      }),
    });

    const result = await clearGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(calls.dispose).toBe(true);
  });
});

describe("clearEditableControl", () => {
  test("bypasses an instance value tracker so controlled inputs observe the clear", () => {
    const window = new Window();
    const input = window.document.createElement("input");
    input.value = "before";
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (!descriptor?.get || !descriptor.set) {
      throw new Error("input value descriptor is unavailable");
    }

    let trackedValue = input.value;
    let observedValue: string | null = null;
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => descriptor.get?.call(input),
      set: (value: string) => {
        trackedValue = value;
        descriptor.set?.call(input, value);
      },
    });
    input.addEventListener("input", () => {
      if (trackedValue !== input.value) {
        observedValue = input.value;
      }
      trackedValue = input.value;
    });

    clearEditableControl(input as unknown as Element);

    expect(input.value).toBe("");
    expect(observedValue).toBe("");
  });

  test("treats ARIA read-only editable controls as read-only", () => {
    const window = new Window();
    window.document.body.innerHTML = `<div role="textbox" contenteditable="true" aria-readonly="true">locked</div>`;
    const control = window.document.querySelector("[role=textbox]");
    if (!control) {
      throw new Error("fixture control is missing");
    }

    expect(isReadOnly(control as unknown as Element)).toBe(true);
  });
});
