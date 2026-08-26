import { describe, expect, test } from "bun:test";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  handleBrowserRuntimeMessage,
  OBSERVE_SELECTED_TAB_MESSAGE,
} from "../src/browser/runtime";
import type { BrowserState } from "../src/browser/types";

const OBSERVED_STATE: BrowserState = {
  tabId: 7,
  url: "https://example.com",
  title: "Example",
  tabs: [
    { tabId: 7, url: "https://example.com", title: "Example", attached: true, selected: true },
  ],
  scroll: { x: 0, y: 0, maxX: 0, maxY: 0, atTop: true, atBottom: true, atLeft: true, atRight: true },
  dom: "[1]<a href=https://example.com>Example</a>",
  refs: [{ ref: 1, tag: "a", role: "link", name: "Example", attrs: {}, bounds: null }],
  screenshot: { mimeType: "image/jpeg", data: "base64", width: 800, height: 600 },
  snapshotId: "snap-9" as BrowserState["snapshotId"],
  snapshotVersion: 3,
  documentEpoch: 2,
  navigationEpoch: 4,
};

describe("browser runtime messages", () => {
  test("the side-panel attach message invokes active-tab attachment", async () => {
    let calls = 0;
    const result = await handleBrowserRuntimeMessage(
      { type: ATTACH_ACTIVE_TAB_MESSAGE },
      {
        useActiveTab: async () => {
          calls += 1;
          return { ok: true, tabId: 7 };
        },
        observe: async () => {
          throw new Error("observe must not run");
        },
      },
    );

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(calls).toBe(1);
  });

  test("the observe message returns the full browser state unchanged", async () => {
    let observeCalls = 0;
    let attachCalls = 0;
    const result = await handleBrowserRuntimeMessage(
      { type: OBSERVE_SELECTED_TAB_MESSAGE },
      {
        useActiveTab: async () => {
          attachCalls += 1;
          return { ok: true, tabId: 7 };
        },
        observe: async () => {
          observeCalls += 1;
          return { ok: true, state: OBSERVED_STATE };
        },
      },
    );

    expect(result).toEqual({ ok: true, state: OBSERVED_STATE });
    expect(observeCalls).toBe(1);
    expect(attachCalls).toBe(0);

    if (result && "state" in result) {
      expect(result.state.snapshotId).toBe("snap-9");
      expect(result.state.snapshotVersion).toBe(3);
      expect(result.state.documentEpoch).toBe(2);
      expect(result.state.navigationEpoch).toBe(4);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  test("unrelated extension messages are ignored", async () => {
    let attachCalls = 0;
    let observeCalls = 0;
    const result = await handleBrowserRuntimeMessage(
      { type: "unrelated" },
      {
        useActiveTab: async () => {
          attachCalls += 1;
          return { ok: true, tabId: 7 };
        },
        observe: async () => {
          observeCalls += 1;
          return { ok: true, state: OBSERVED_STATE };
        },
      },
    );

    expect(result).toBeNull();
    expect(attachCalls).toBe(0);
    expect(observeCalls).toBe(0);
  });
});
