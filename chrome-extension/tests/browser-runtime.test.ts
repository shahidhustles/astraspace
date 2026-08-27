import { describe, expect, test } from "bun:test";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  attachTabActionCoordinator,
  handleBrowserRuntimeMessage,
  OBSERVE_SELECTED_TAB_MESSAGE,
  type BrowserRuntime,
} from "../src/browser/runtime";
import type { BrowserState, GroundedTarget } from "../src/browser/types";

const STALE_TARGET: GroundedTarget = {
  tabId: 7,
  snapshotId: "snap-9" as GroundedTarget["snapshotId"],
  ref: 1,
};

const OBSERVED_STATE: BrowserState = {
  tabId: 7,
  url: "https://example.com",
  title: "Example",
  tabs: [
    { tabId: 7, url: "https://example.com", title: "Example", attached: true, selected: true },
  ],
  scroll: { x: 0, y: 0, maxX: 0, maxY: 0, atTop: true, atBottom: true, atLeft: true, atRight: true },
  dom: [
    "[1]<a href=https://example.com>Example</a>",
    "<frame>",
    "  [2]<button>Child action</button>",
    "</frame>",
    "<#shadow-root>",
    "  [3]<button>Shadow action</button>",
    "</#shadow-root>",
  ].join("\n"),
  refs: [
    { ref: 1, tag: "a", role: "link", name: "Example", attrs: {}, bounds: null },
    {
      ref: 2,
      tag: "button",
      role: "button",
      name: "Child action",
      attrs: {},
      bounds: { x: 120, y: 40, width: 100, height: 32 },
    },
    {
      ref: 3,
      tag: "button",
      role: "button",
      name: "Shadow action",
      attrs: {},
      bounds: { x: 12, y: 90, width: 110, height: 32 },
    },
  ],
  screenshot: { mimeType: "image/jpeg", data: "base64", width: 800, height: 600 },
  snapshotId: "snap-9" as BrowserState["snapshotId"],
  snapshotVersion: 3,
  documentEpoch: 2,
  navigationEpoch: 4,
};

function fakeRuntime(overrides: Partial<BrowserRuntime> = {}): BrowserRuntime {
  return attachTabActionCoordinator({
    selectedTabId: 7,
    useActiveTab: async () => ({ ok: true, tabId: 7 }),
    observe: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    navigate: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    goBack: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    refresh: async () => ({ ok: false, error: { code: "selected_tab_unavailable", message: "not used" } }),
    click: async () => ({ ok: false, error: { code: "stale_ref", message: "not used", target: STALE_TARGET } }),
    openTab: async () => ({ ok: false, error: { code: "chrome_api_error", message: "not used" } }),
    switchTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    closeTab: async () => ({ ok: false, error: { code: "missing_tab", message: "not used" } }),
    listTabs: async () => ({ ok: true, tabs: [] }),
    ...overrides,
  });
}

describe("browser runtime messages", () => {
  test("the side-panel attach message invokes active-tab attachment", async () => {
    let calls = 0;
    const runtime = fakeRuntime({
      useActiveTab: async () => {
        calls += 1;
        return { ok: true, tabId: 7 };
      },
    });

    const result = await handleBrowserRuntimeMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }, runtime);

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(calls).toBe(1);
  });

  test("the observe message returns the full browser state unchanged", async () => {
    let observeCalls = 0;
    let attachCalls = 0;
    const runtime = fakeRuntime({
      useActiveTab: async () => {
        attachCalls += 1;
        return { ok: true, tabId: 7 };
      },
      observe: async () => {
        observeCalls += 1;
        return { ok: true, state: OBSERVED_STATE };
      },
    });

    const result = await handleBrowserRuntimeMessage({ type: OBSERVE_SELECTED_TAB_MESSAGE }, runtime);

    expect(result).toEqual({ ok: true, state: OBSERVED_STATE });
    expect(observeCalls).toBe(1);
    expect(attachCalls).toBe(0);

    if (result && "state" in result) {
      expect(result.state.snapshotId).toBe("snap-9");
      expect(result.state.snapshotVersion).toBe(3);
      expect(result.state.documentEpoch).toBe(2);
      expect(result.state.navigationEpoch).toBe(4);
      expect(result.state.refs.map((ref) => ref.ref)).toEqual([1, 2, 3]);
      expect(result.state.dom).toContain("<frame>");
      expect(result.state.dom).toContain("<#shadow-root>");
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  test("unrelated extension messages are ignored", async () => {
    let attachCalls = 0;
    let observeCalls = 0;
    const runtime = fakeRuntime({
      useActiveTab: async () => {
        attachCalls += 1;
        return { ok: true, tabId: 7 };
      },
      observe: async () => {
        observeCalls += 1;
        return { ok: true, state: OBSERVED_STATE };
      },
    });

    const result = await handleBrowserRuntimeMessage({ type: "unrelated" }, runtime);

    expect(result).toBeNull();
    expect(attachCalls).toBe(0);
    expect(observeCalls).toBe(0);
  });
});
