import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
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
import { BROWSER_ACTION_MESSAGE, SELECT_OPTIONS_LIMIT, type SelectOption } from "../src/browser/actions/types";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
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
    scroll: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    scrollToText: async () => ({ ok: true, url: "https://example.com", position: { x: 0, y: 0 } }),
    getSelectOptions: async () => ({ ok: true, url: "https://example.com", options: OPTIONS, optionsTruncated: false }),
    selectOption: async () => ({ ok: true, url: "https://example.com", selectedIndex: 1 }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  });
}

describe("browser_get_select_options dispatch", () => {
  test("returns ordered options without invalidating the snapshot", async () => {
    let received: GroundedTarget | null = null;
    const runtime = fakeRuntime({
      getSelectOptions: async (target) => {
        received = target;
        return { ok: true, url: "https://example.com/final", options: OPTIONS, optionsTruncated: true };
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
      data: {
        kind: "get_select_options",
        options: OPTIONS,
        optionsTruncated: true,
        measured: {
          actionId: expect.any(String),
          lifecycle: { status: "completed", completedBy: "read_only_inspection", elapsedMs: expect.any(Number) },
        },
      },
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
      evaluate: async (fn: (node: Element, ...args: unknown[]) => unknown, ...args: unknown[]) => {
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
    deps.resolveTarget = resolveWith(log, calls, { options: { records: OPTIONS, total: OPTIONS.length } });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/final",
      options: OPTIONS,
      optionsTruncated: false,
    });
    expect(log).toEqual(["resolve"]);
    expect(calls.read).toBe(true);
    expect(calls.dispose).toBe(true);
  });

  test("flags truncation without altering returned records", async () => {
    const calls = { read: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = resolveWith(log, calls, { options: { records: OPTIONS, total: 90 } });

    const result = await getSelectOptions(TARGET, deps);

    expect(result).toEqual({
      ok: true,
      url: "https://example.com/final",
      options: OPTIONS,
      optionsTruncated: true,
    });
    expect(log).toEqual(["resolve"]);
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

describe("native select disabled state", () => {
  test("reports options as disabled when their select or optgroup is disabled", () => {
    const window = new Window();
    window.document.body.innerHTML = `
      <select id="disabled-select" disabled><option value="a">Alpha</option></select>
      <select id="grouped"><optgroup disabled><option value="b">Beta</option></optgroup></select>
    `;
    const disabledSelect = window.document.querySelector("#disabled-select");
    const groupedSelect = window.document.querySelector("#grouped");
    if (!disabledSelect || !groupedSelect) {
      throw new Error("select fixture is missing");
    }

    expect(readSelectOptions(disabledSelect as unknown as Element)?.records[0]?.disabled).toBe(true);
    expect(readSelectOptions(groupedSelect as unknown as Element)?.records[0]?.disabled).toBe(true);
  });

  test("rejects a disabled select and an option in a disabled optgroup", () => {
    const window = new Window();
    window.document.body.innerHTML = `
      <select id="disabled-select" disabled>
        <option value="a">Alpha</option><option value="b">Beta</option>
      </select>
      <select id="grouped">
        <option value="a">Alpha</option>
        <optgroup disabled><option value="b">Beta</option></optgroup>
      </select>
    `;
    const disabledSelect = window.document.querySelector("#disabled-select");
    const groupedSelect = window.document.querySelector("#grouped");
    if (!disabledSelect || !groupedSelect) {
      throw new Error("select fixture is missing");
    }

    const identity = { index: 1, label: "Beta", value: "b" };
    expect(findOptionMatch(disabledSelect as unknown as Element, identity)).toEqual({ kind: "disabled_select" });
    expect(findOptionMatch(groupedSelect as unknown as Element, identity)).toEqual({ kind: "disabled" });
  });
});

describe("bounded select inspection", () => {
  function windowWithOptions(count: number, selectedIndex?: number): Window {
    const win = new Window({ url: "https://fixture.test/" });
    const options = Array.from(
      { length: count },
      (_, index) => `<option value="v${index}">Label ${index}</option>`,
    ).join("");
    win.document.body.innerHTML = `<select id="big">${options}</select>`;
    if (selectedIndex !== undefined) {
      (win.document.querySelector("#big") as unknown as HTMLSelectElement).selectedIndex =
        selectedIndex;
    }
    return win;
  }

  function optionRow(index: number, selected = false): SelectOption {
    return {
      index,
      label: `Label ${index}`,
      value: `v${index}`,
      disabled: false,
      selected,
    };
  }

  test(`returns at most ${SELECT_OPTIONS_LIMIT} complete records with truncation flagged`, () => {
    const win = windowWithOptions(SELECT_OPTIONS_LIMIT + 5);
    const select = win.document.querySelector("#big") as unknown as Element;

    const page = readSelectOptions(select);

    expect(page).not.toBeNull();
    expect(page?.total).toBe(SELECT_OPTIONS_LIMIT + 5);
    expect(page?.records.length).toBe(SELECT_OPTIONS_LIMIT);
    expect(page?.records[0]).toEqual(optionRow(0, true));
    expect(page?.records[SELECT_OPTIONS_LIMIT - 1]).toEqual(optionRow(SELECT_OPTIONS_LIMIT - 1));
  });

  test("keeps the selected row visible inside a capped list", () => {
    const win = windowWithOptions(SELECT_OPTIONS_LIMIT + 2, 3);
    const page = readSelectOptions(win.document.querySelector("#big") as unknown as Element);

    expect(page?.records[3]?.selected).toBe(true);
    expect(page?.records.filter((record) => record.selected)).toEqual([optionRow(3, true)]);
  });

  test("returns every record untruncated when under the cap", () => {
    const win = windowWithOptions(SELECT_OPTIONS_LIMIT);
    const page = readSelectOptions(win.document.querySelector("#big") as unknown as Element);

    expect(page?.total).toBe(SELECT_OPTIONS_LIMIT);
    expect(page?.records.length).toBe(SELECT_OPTIONS_LIMIT);
    expect(page?.records[SELECT_OPTIONS_LIMIT - 1]).toEqual(optionRow(SELECT_OPTIONS_LIMIT - 1));
  });

  test("never truncates oversized identity text and stays JSON-safe", async () => {
    const longText = "L".repeat(5000);
    const win = new Window({ url: "https://fixture.test/" });
    win.document.body.innerHTML =
      `<select id="wide"><option value="${longText}">${longText}</option></select>`;
    const page = readSelectOptions(win.document.querySelector("#wide") as unknown as Element);

    expect(page?.total).toBe(1);
    expect(page?.records[0]?.label).toBe(longText);
    expect(page?.records[0]?.value).toBe(longText);

    const result = await getSelectOptions(TARGET, await Promise.resolve({
      resolveTarget: async (): Promise<TargetResolutionResult> => ({
        ok: true,
        element: {
          evaluate: async (fn: unknown) =>
            fn === readSelectOptions ? page : null,
          dispose: async () => {},
        } as unknown as ElementHandle<Element>,
      }),
      invalidate: () => {},
      currentUrl: () => "https://example.com/final",
    }));
    expect(result.ok).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("every returned option remains selectable by its exact identity", async () => {
    const win = new Window({ url: "https://fixture.test/" });
    const body = Array.from(
      { length: SELECT_OPTIONS_LIMIT },
      (_, index) => `<option value="v${index}">Label ${index}</option>`,
    ).join("");
    win.document.body.innerHTML = `<select id="big">${body}</select>`;
    const element = win.document.querySelector("#big") as unknown as Element;
    (element as unknown as HTMLSelectElement).selectedIndex = -1;
    const page = readSelectOptions(element);
    for (const record of page?.records ?? []) {
      const lookup = findOptionMatch(element, {
        index: record.index,
        label: record.label,
        value: record.value,
      });
      expect(lookup.kind === "ok" && !lookup.selected).toBe(true);
    }
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
          return opts.lookup ?? { kind: "ok", index: 1, selected: false };
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
    ["disabled select", { kind: "disabled_select" }, "disabled_target"],
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

  test("rejects an option that is already selected without invalidating", async () => {
    const calls = { find: false, apply: false, dispose: false };
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async (): Promise<TargetResolutionResult> => {
      log.push("resolve");
      return {
        ok: true,
        element: fakeHandle(calls, {
          lookup: { kind: "ok", index: 1, selected: true },
        }),
      };
    };

    const result = await selectOption(TARGET, IDENTITY, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "The requested option is already selected" },
    });
    expect(log).toEqual(["resolve"]);
    expect(calls.apply).toBe(false);
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
