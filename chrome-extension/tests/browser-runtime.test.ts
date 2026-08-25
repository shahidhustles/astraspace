import { describe, expect, test } from "bun:test";
import {
  ATTACH_ACTIVE_TAB_MESSAGE,
  handleBrowserRuntimeMessage,
} from "../src/browser/runtime";

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
      },
    );

    expect(result).toEqual({ ok: true, tabId: 7 });
    expect(calls).toBe(1);
  });

  test("unrelated extension messages are ignored", async () => {
    let calls = 0;
    const result = await handleBrowserRuntimeMessage(
      { type: "unrelated" },
      {
        useActiveTab: async () => {
          calls += 1;
          return { ok: true, tabId: 7 };
        },
      },
    );

    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});
