import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ElementHandle } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { clickGroundedTarget, isHitTestTarget, type ClickDeps } from "../src/browser/actions/element";
import { BROWSER_ACTION_MESSAGE } from "../src/browser/actions/types";
import { isDisabled } from "../src/browser/observation/extract";
import { attachTabActionCoordinator, handleBrowserRuntimeMessage, type BrowserRuntime } from "../src/browser/runtime";
import type { GroundedTarget, TargetResolutionResult } from "../src/browser/types";

const TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-1" as GroundedTarget["snapshotId"],
  ref: 2,
};

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return attachTabActionCoordinator({
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    click: async () => ({ ok: true, url: "https://example.com", newTabId: null }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  });
}

describe("browser_click dispatch", () => {
  test("clicks the grounded target through the action contract", async () => {
    let clickedTarget: GroundedTarget | null = null;
    const runtime = fakeRuntime({
      click: async (target) => {
        clickedTarget = target;
        return { ok: true, url: "https://example.com/final", newTabId: null };
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: TARGET },
      runtime,
    );

    expect(clickedTarget).toEqual(TARGET);
    expect(result).toEqual({
      ok: true,
      action: "browser_click",
      tabId: 7,
      url: "https://example.com/final",
      snapshotInvalidated: true,
      data: { kind: "click", newTabId: null },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test("reports a tab created by the click", async () => {
    const runtime = fakeRuntime({
      click: async () => ({ ok: true, url: "https://example.com", newTabId: 42 }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: TARGET },
      runtime,
    );

    expect(result).toEqual({
      ok: true,
      action: "browser_click",
      tabId: 7,
      url: "https://example.com",
      snapshotInvalidated: true,
      data: { kind: "click", newTabId: 42 },
    });
  });

  test("preserves grounded-target failures without wrapping them", async () => {
    for (const code of ["stale_ref", "target_not_found", "ambiguous_ref"] as const) {
      const runtime = fakeRuntime({
        click: async () => ({ ok: false, error: { code, message: `reason for ${code}`, target: TARGET } }),
      });
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: TARGET },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_click",
        tabId: 7,
        error: { code, message: `reason for ${code}`, target: TARGET },
      });
    }
  });

  test("attributes a grounded failure to the requested tab", async () => {
    const target = { ...TARGET, tabId: 41 };
    const runtime = fakeRuntime({
      selectedTabId: 7,
      click: async () => ({ ok: false, error: { code: "stale_ref", message: "stale", target } }),
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: target },
      runtime,
    );

    expect(result).toMatchObject({ ok: false, action: "browser_click", tabId: 41 });
  });

  test("preserves interaction failures with their specific code", async () => {
    const cases = [
      { code: "disabled_target", message: "Element is disabled" },
      { code: "not_interactable", message: "Element is not visible" },
      { code: "file_upload_required", message: "File upload is not supported" },
    ] as const;
    for (const error of cases) {
      const runtime = fakeRuntime({
        click: async () => ({ ok: false, error }),
      });
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: TARGET },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_click",
        tabId: 7,
        error,
      });
    }
  });

  test("returns action_failed when the click runtime throws", async () => {
    const runtime = fakeRuntime({
      click: async () => {
        throw new Error("boom");
      },
    });

    const result = await handleBrowserRuntimeMessage(
      { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input: TARGET },
      runtime,
    );

    expect(result).toEqual({
      ok: false,
      action: "browser_click",
      tabId: 7,
      error: { code: "action_failed", message: "Browser action failed" },
    });
  });

  test("rejects a malformed click request with invalid_action", async () => {
    const runtime = fakeRuntime();
    const badInputs = [
      {},
      { tabId: "7", snapshotId: "snap-1", ref: 2 },
      { tabId: 7, snapshotId: "", ref: 2 },
      { tabId: 7, snapshotId: "snap-1", ref: 0 },
      { tabId: 7, snapshotId: "snap-1", ref: 1.5 },
      { tabId: 7, snapshotId: "snap-1", ref: 2, extra: true },
    ];
    for (const input of badInputs) {
      const result = await handleBrowserRuntimeMessage(
        { type: BROWSER_ACTION_MESSAGE, action: "browser_click", input },
        runtime,
      );
      expect(result).toEqual({
        ok: false,
        action: "browser_click",
        tabId: null,
        error: { code: "invalid_action", message: expect.stringContaining("browser_click") },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });
});

describe("disabled interaction state", () => {
  test("includes native fieldset and ARIA-disabled ancestor state", () => {
    const window = new Window();
    window.document.body.innerHTML = `
      <fieldset disabled><input id="native" /></fieldset>
      <div aria-disabled="true"><button id="aria">Blocked</button></div>
    `;

    expect(isDisabled(window.document.querySelector("#native") as unknown as Element)).toBe(true);
    expect(isDisabled(window.document.querySelector("#aria") as unknown as Element)).toBe(true);
  });
});

describe("clickGroundedTarget", () => {
  interface FakeHandleCalls {
    evaluate: boolean;
    isHidden: boolean;
    scrollIntoView: boolean;
    click: boolean;
    dispose: boolean;
    fileInput: boolean;
    disabled: boolean;
    hitTest: boolean;
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
        if (fn === isHitTestTarget) {
          return calls.hitTest;
        }
        return calls.fileInput;
      },
      isHidden: async () => {
        calls.isHidden = true;
        return false;
      },
      scrollIntoView: async () => {
        calls.scrollIntoView = true;
      },
      click: async () => {
        calls.click = true;
      },
      dispose: async () => {
        calls.dispose = true;
      },
      ...overrides,
    } as unknown as ElementHandle<Element>;
  }

  interface FakeDeps {
    log: string[];
    deps: ClickDeps;
    listeners: Array<(tab: chrome.tabs.Tab) => void>;
  }

  function fakeDeps(overrides: Partial<ClickDeps> = {}): FakeDeps {
    const log: string[] = [];
    const listeners: Array<(tab: chrome.tabs.Tab) => void> = [];
    return {
      log,
      listeners,
      deps: {
        resolveTarget: async (): Promise<TargetResolutionResult> => {
          log.push("resolve");
          return { ok: true, element: fakeHandle(handleCalls()) };
        },
        onCreated: (listener) => {
          listeners.push(listener);
          log.push("listen");
          return () => log.push("stop");
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
      click: false,
      dispose: false,
      fileInput: false,
      disabled: false,
      hitTest: true,
    };
  }

  test("resolves, prepares, invalidates, clicks, and cleans up in order", async () => {
    const calls = handleCalls();
    const { log, deps } = fakeDeps();
    deps.resolveTarget = async () => {
      log.push("resolve");
      return { ok: true, element: fakeHandle(calls) };
    };

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", newTabId: null });
    expect(log).toEqual(["resolve", "listen", "invalidate", "stop"]);
    expect(calls.evaluate).toBe(true);
    expect(calls.isHidden).toBe(true);
    expect(calls.scrollIntoView).toBe(true);
    expect(calls.click).toBe(true);
    expect(calls.dispose).toBe(true);
    expect(log).toContain("stop");
    expect(log.indexOf("listen")).toBeLessThan(log.indexOf("invalidate"));
  });

  test("reports a tab observed while the click was in flight", async () => {
    const calls = handleCalls();
    const { listeners, deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: true,
        element: fakeHandle(calls, {
          click: async () => {
            listeners[0]?.({ id: 42, openerTabId: TARGET.tabId } as chrome.tabs.Tab);
          },
        }),
      }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", newTabId: 42 });
    expect(listeners).toHaveLength(1);
  });

  test("ignores tabs that were not opened by the clicked tab", async () => {
    const calls = handleCalls();
    const { listeners, deps } = fakeDeps({
      resolveTarget: async () => ({
        ok: true,
        element: fakeHandle(calls, {
          click: async () => {
            listeners[0]?.({ id: 41, openerTabId: 99 } as chrome.tabs.Tab);
            listeners[0]?.({ id: 42, openerTabId: TARGET.tabId } as chrome.tabs.Tab);
          },
        }),
      }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({ ok: true, url: "https://example.com/final", newTabId: 42 });
  });

  test("stops the listener and disposes the handle when the click throws", async () => {
    const calls = handleCalls();
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls, { click: async () => { throw new Error("detached"); } }) }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "action_failed", message: "Element interaction failed" },
    });
    expect(log).toEqual(["listen", "invalidate", "stop"]);
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

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "stale_ref", message: "stale", target: TARGET },
    });
    expect(log).toEqual([]);
    expect(calls.dispose).toBe(false);
    expect(calls.evaluate).toBe(false);
  });

  test("rejects a disabled target without registering the listener or invalidating", async () => {
    const calls = { ...handleCalls(), disabled: true };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "disabled_target", message: "Element is disabled" },
    });
    expect(log).toEqual([]);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a file input before any click", async () => {
    const calls = { ...handleCalls(), fileInput: true };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "file_upload_required", message: "File upload is not supported" },
    });
    expect(log).toEqual([]);
    expect(calls.click).toBe(false);
    expect(calls.dispose).toBe(true);
  });

  test("rejects a target whose click point is covered", async () => {
    const calls = { ...handleCalls(), hitTest: false };
    const { log, deps } = fakeDeps({
      resolveTarget: async () => ({ ok: true, element: fakeHandle(calls) }),
    });

    const result = await clickGroundedTarget(TARGET, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: "not_interactable", message: "Element is covered or cannot receive pointer events" },
    });
    expect(log).toEqual([]);
    expect(calls.click).toBe(false);
    expect(calls.dispose).toBe(true);
  });
});
