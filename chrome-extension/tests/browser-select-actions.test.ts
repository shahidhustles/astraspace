import { describe, expect, test } from "bun:test";
import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import {
  applyOptionSelection,
  findOptionMatch,
  getSelectOptions,
  readSelectOptions,
  selectOption,
  type SelectDeps,
  type SelectLookup,
} from "../src/browser/actions/select";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};

const OPTIONS = [
  { index: 0, label: "Alpha", value: "alpha", disabled: false, selected: true },
  { index: 1, label: "Beta", value: "beta", disabled: false, selected: false },
];

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
    scroll: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    scrollToText: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    getSelectOptions: async () => ({ ok: true, url: "https://example.com", options: OPTIONS }),
    selectOption: async () => ({ ok: true, url: "https://example.com", selectedIndex: 1 }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  };
}

describe("browser_get_select_options dispatch", () => {
  test("returns ordered options without invalidating the snapshot", async () => {
    let received: GroundedTarget | null = null;
    const runtime = fakeRuntime({
      getSelectOptions: async (target) => {
        received = target;
        return { ok: true, url: "https://example.com/final", options: OPTIONS };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: TARGET },
      runtime,
    );

    expect(received).toEqual(TARGET);
    expect(result).toEqual({
      ok: true,
      action: "browser_get_select_options",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: false,
      data: { kind: "get_select_options", options: OPTIONS },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("preserves grounded-target and not_native_select failures", async () => {
    const failures = [
      { code: "stale_ref", message: "stale", target: TARGET },
      { code: "not_native_select", message: "Element is not a native select" },
    ] as const;
    for (const error of failures) {
      const runtime = fakeRuntime({
        getSelectOptions: async () => ({ ok: false, error }),
      });
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input: TARGET },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_get_select_options",
        tabId: 7,
        error,
      });
    }
  });

  test("rejects a malformed request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { tabId: 7, snapshotId: "s", ref: 2, extra: true },
      { ...TARGET, ref: 0 },
      { ...TARGET, ref: 1.5 },
      { ...TARGET, snapshotId: "" },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_get_select_options", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_get_select_options",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_get_select_options") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("browser_select_option dispatch", () => {
  test("selects the option through the action contract and invalidates", async () => {
    let received: { target: GroundedTarget; option: unknown } | null = null;
    const runtime = fakeRuntime({
      selectOption: async (target, option) => {
        received = { target, option };
        return { ok: true, url: "https://example.com/final", selectedIndex: 1 };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      {
        type: BROWSER_ACTION_MESSAGE,
        action: "browser_select_option",
        input: { target: TARGET, index: 1, label: "Beta", value: "beta" },
      },
      runtime,
    );

    expect(received).toEqual({ target: TARGET, option: { index: 1, label: "Beta", value: "beta" } });
    expect(result).toEqual({
      ok: true,
      action: "browser_select_option",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "select_option", selectedIndex: 1 },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("preserves option and grounded-target failures", async () => {
    const failures = [
      { code: "option_not_found", message: "No option matches the requested choice" },
      { code: "option_disabled", message: "The matching option is disabled" },
      { code: "ambiguous_option", message: "Multiple options match the requested choice" },
      { code: "not_native_select", message: "Element is not a native select" },
      { code: "stale_ref", message: "stale", target: TARGET },
    ] as const;
    for (const error of failures) {
      const runtime = fakeRuntime({
        selectOption: async () => ({ ok: false, error }),
      });
      const result = await handleBrowserRuntimeMessage(
        {
          type: BROWSER_ACTION_MESSAGE,
          action: "browser_select_option",
          input: { target: TARGET, index: 1, label: "Beta", value: "beta" },
        },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_select_option",
        tabId: 7,
        error,
      });
    }
  });

  test("rejects a malformed select request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const valid = { target: TARGET, index: 1, label: "Beta", value: "beta" };
    const badInputs = [
      {},
      { target: TARGET },
      { target: TARGET, index: -1, label: "Beta", value: "beta" },
      { target: TARGET, index: 1.5, label: "Beta", value: "beta" },
      { target: TARGET, index: 1, label: 5, value: "beta" },
      { target: TARGET, index: 1, label: "Beta" },
      { target: { ...TARGET, ref: 0 }, index: 1, label: "Beta", value: "beta" },
      { ...valid, extra: true },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_select_option", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_select_option",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_select_option") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("getSelectOptions", () => {
  interface Calls {
    read: boolean;
    dispose: boolean;
  }

  function fakeHandle(
    calls: Calls,
    opts: { options?: unknown; throws?: boolean } = {},
  ): ElementHandle<Element> {
    return {
      evaluate: async (fn: (node: Element) => unknown) => {
        if (fn === readSelectOptions) {
          calls.read = true;
          if (opts.throws) {
            throw new Error("detached");
          }
          return opts.options ?? null;
        }
        return undefined;
      },
      dispose: async () => {
        calls.dispose = true;
      },
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<SelectDeps> = {}): { log: string[]; deps: SelectDeps } {
    const log: string[] = [];
    return {
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle({ read: false, dispose: false }) };
        },
        invalidate: () => log.push("invalidate"),
        currentUrl: () => "https://example.com/final",
        ...overrides,
      },
    };
  }

  function resolveWith(log: string[], calls: Calls, opts: Parameters<typeof fakeHandle>[1] = {}) {
    return async (): Promise<TargetResolutionResult> => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls, opts) };
    };
  }

  test("resolves, reads options, does not invalidate, and cleans up", async () => {
    const calls = { read: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = resolveWith(log, calls, { options: OPTIONS });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", options: OPTIONS });
    expect(log).toEqual(["resolve"]);
    expect(calls.read).toBe(true);
    expect(calls.dispose).toBe(true);
  });

  test("returns not_native_select for a non-select without invalidating", async () => {
    const calls = { read: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = resolveWith(log, calls, { options: null });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "not_native_select", message: "Element is not a native select" },
    });
    expect(log).toEqual(["resolve"]);
    expect(calls.dispose).toBe(true);
  });

  test("touches nothing when resolution fails", async () => {
    const calls = { read: false, dispose: false };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: false, code: "stale_ref", target: TARGET, reason: "stale" }),
    });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({ ok: false, error: { code: "stale_ref", message: "stale", target: TARGET } });
    expect(log).toEqual([]);
    expect(calls.read).toBe(false);
    expect(calls.dispose).toBe(false);
  });

  test("disposes the handle when reading throws", async () => {
    const calls = { read: false, dispose: false };
    const { deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => ({
      ok: true,
      element: fakeHandle(calls, { throws: true }),
    });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({ ok: false, error: { code: "action_failed", message: "Element interaction failed" } });
    expect(calls.dispose).toBe(true);
  });
});

describe("selectOption", () => {
  interface Calls {
    find: boolean;
    apply: boolean;
    dispose: boolean;
  }

  function fakeHandle(
    calls: Calls,
    opts: { lookup?: SelectLookup; selectedIndex?: number | null; throwsOn?: (fn: unknown) => boolean } = {},
  ): ElementHandle<Element> {
    return {
      evaluate: async (fn: (node: Element, ...args: unknown[]) => unknown, ...args: unknown[]) => {
        if (opts.throwsOn?.(fn)) {
          throw new Error("detached");
        }
        if (fn === findOptionMatch) {
          calls.find = true;
          return opts.lookup ?? { kind: "ok", index: 1 };
        }
        if (fn === applyOptionSelection) {
          calls.apply = true;
          return opts.selectedIndex === undefined ? 1 : opts.selectedIndex;
        }
        return undefined;
      },
      dispose: async () => {
        calls.dispose = true;
      },
    } as unknown as ElementHandle<Element>;
  }

  function fakeDeps(overrides: Partial<SelectDeps> = {}): { log: string[]; deps: SelectDeps } {
    const log: string[] = [];
    return {
      log,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle({ find: false, apply: false, dispose: false }) };
        },
        invalidate: () => log.push("invalidate"),
        currentUrl: () => "https://example.com/final",
        ...overrides,
      },
    };
  }

  const IDENTITY = { index: 1, label: "Beta", value: "beta" };

  test("resolves, verifies, invalidates, applies, verifies, and cleans up in order", async () => {
    const calls = { find: false, apply: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls, { selectedIndex: 1 }) };
    };

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", selectedIndex: 1 });
    expect(log).toEqual(["resolve", "invalidate"]);
    expect(calls.find).toBe(true);
    expect(calls.apply).toBe(true);
    expect(calls.dispose).toBe(true);
  });

  test.each([
    ["missing", { kind: "missing" }, "option_not_found"],
    ["disabled", { kind: "disabled" }, "option_disabled"],
    ["ambiguous", { kind: "ambiguous", count: 2 }, "ambiguous_option"],
    ["not native", { kind: "not_native" }, "not_native_select"],
  ] as const)("rejects a %s match before invalidating", async (_name, lookup, code) => {
    const calls = { find: false, apply: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls, { lookup }) };
    };

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
    expect(log).toEqual(["resolve"]);
    expect(calls.apply).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("touches nothing when resolution fails", async () => {
    const calls = { find: false, apply: false, dispose: false };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: false, code: "target_not_found", target: TARGET, reason: "gone" }),
    });

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({ ok: false, error: { code: "target_not_found", message: "gone", target: TARGET } });
    expect(log).toEqual([]);
    expect(calls.find).toBe(false);
    expect(calls.dispose).toBe(false);
  });

  test("returns action_failed when the applied selection does not take effect", async () => {
    const calls = { find: false, apply: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls, { selectedIndex: null }) };
    };

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({ ok: false, error: { code: "action_failed", message: "The option could not be selected" } });
    expect(log).toEqual(["resolve", "invalidate"]);
    expect(calls.dispose).toBe(true);
  });

  test("disposes the handle when a verification evaluation throws", async () => {
    const calls = { find: false, apply: false, dispose: false };
    const { deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => ({
      ok: true,
      element: fakeHandle(calls, {
        throwsOn: (fn) => fn === applyOptionSelection,
      }),
    });

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({ ok: false, error: { code: "action_failed", message: "Element interaction failed" } });
    expect(calls.dispose).toBe(true);
  });
});
