import { afterEach, describe, expect, test } from "bun:test";
import { notifyBrowserActiveTab } from "../src/lib/eve-browser-session";

const originalChrome = (globalThis as { chrome?: unknown }).chrome;

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = originalChrome;
});

describe("browser session wiring", () => {
  test("requests active-tab attachment from the extension worker", async () => {
    const messages: unknown[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: async (message: unknown) => {
          messages.push(message);
        },
      },
    };

    await notifyBrowserActiveTab();

    expect(messages).toEqual([{ type: "browser.attach-active-tab" }]);
  });
});
