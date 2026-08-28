import { afterAll, describe, expect, test } from "bun:test";
import { createMv3Harness, findChrome, type Mv3Harness } from "./helpers/mv3-worker-harness";

describe("browser runtime inside a real unpacked MV3 service worker", () => {
  let harness: Mv3Harness | null = null;

  afterAll(async () => {
    await harness?.close();
  });

  test("attach, observe, and refresh work through chrome.runtime.sendMessage", async () => {
    if (!findChrome()) {
      throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
    }
    const messages = JSON.stringify({
      attach: "browser.attach-active-tab",
      observe: "browser.observe-selected-tab",
      action: "browser.action",
    });
    harness = await createMv3Harness({
      driverHtmlName: "mv3-smoke.html",
      driverJs: (origin) => `(async () => {
        const S = ${JSON.stringify(origin)};
        const M = ${messages};
        const post = (record) => fetch(S + "/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "smoke", record }),
        }).catch(() => {});
        try {
          const send = (message) => chrome.runtime.sendMessage(message);
          const fixtureUrl = S + "/fixture";
          const opened = await send({ type: M.action, action: "browser_open_tab", input: { url: fixtureUrl } });
          const tab = await chrome.tabs.create({ url: fixtureUrl, active: true });
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const current = await chrome.tabs.get(tab.id);
            if (current.status === "complete") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const attach = await send({ type: M.attach });
          const observe = await send({ type: M.observe });
          const refresh = await send({ type: M.action, action: "browser_refresh", input: {} });
          await post({ opened, attach, observe, refresh });
        } catch (error) {
          await post({ error: String(error) });
        }
      })();`,
    });

    interface SmokeRecord {
      opened?: {
        ok: boolean;
        action?: string;
        tabId?: number;
        url?: string;
        completion?: { status?: string };
        error?: unknown;
      };
      attach?: { ok: boolean; tabId?: number; error?: unknown };
      observe?: {
        ok: boolean;
        state?: { refs: unknown[]; snapshotId?: string; dom?: string };
        error?: unknown;
      };
      refresh?: {
        ok: boolean;
        action?: string;
        tabId?: number;
        url?: string;
        snapshotInvalidated?: boolean;
        data?: { kind?: string };
        completion?: { status?: string };
        error?: unknown;
      };
      error?: string;
    }

    const record = await harness.report<SmokeRecord>("smoke");

    expect(record.error).toBeUndefined();
    expect(record.opened).toMatchObject({
      ok: true,
      action: "browser_open_tab",
      url: expect.stringContaining("/fixture"),
      completion: { status: "completed" },
    });
    expect(record.attach?.ok).toBe(true);
    expect(record.observe?.ok).toBe(true);
    expect(record.observe?.state?.refs?.length ?? 0).toBeGreaterThan(0);
    expect(record.observe?.state?.snapshotId).toBeTruthy();
    expect(record.refresh).toMatchObject({
      ok: true,
      action: "browser_refresh",
      tabId: record.attach?.tabId,
      url: expect.stringContaining("/fixture"),
      snapshotInvalidated: true,
      data: { kind: "refresh" },
      completion: { status: "completed" },
    });
  }, 60_000);
});
