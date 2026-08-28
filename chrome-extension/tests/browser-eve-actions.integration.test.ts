import { afterAll, describe, expect, test } from "bun:test";
import { createMv3Harness, findChrome, type Mv3Harness } from "./helpers/mv3-worker-harness";

describe("grounded actions through the built MV3 worker", () => {
  let harness: Mv3Harness | null = null;

  afterAll(async () => {
    await harness?.close();
  });

  test("uses an observed target, mutates the page, and re-observes the result", async () => {
    if (!findChrome()) throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
    harness = await createMv3Harness({
      driverHtmlName: "eve-actions-driver.html",
      driverJs: (origin) => `(async () => {
        const S = ${JSON.stringify(origin)};
        const send = (message) => chrome.runtime.sendMessage(message);
        const post = (record) => fetch(S + "/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "eve-actions", record }),
        }).catch(() => {});
        try {
          const tab = await chrome.tabs.create({ url: S + "/fixture?phase=eve-actions", active: true });
          while ((await chrome.tabs.get(tab.id)).status !== "complete") {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const attach = await send({ type: "browser.attach-active-tab" });
          const before = await send({ type: "browser.observe-selected-tab" });
          const ref = before.state.refs.find((entry) => entry.name === "Suggest input");
          const target = { tabId: before.state.tabId, snapshotId: before.state.snapshotId, ref: ref.ref };
          const action = await send({
            type: "browser.action",
            action: "browser_type",
            actionId: "eve-actions-call-1",
            wait: { timeoutMs: 5000 },
            input: { target, text: "astra" },
          });
          const after = await send({ type: "browser.observe-selected-tab" });
          await post({ attach, beforeSnapshot: before.state.snapshotId, action, after });
        } catch (error) {
          await post({ error: String(error) });
        }
      })();`,
    });

    const record = await harness.report<{
      error?: string;
      attach?: { ok: boolean };
      beforeSnapshot?: string;
      action?: { ok: boolean; action?: string; snapshotInvalidated?: boolean; completion?: { status: string } };
      after?: { ok: boolean; state?: { snapshotId: string; dom: string } };
    }>("eve-actions", 30_000);
    expect(record.error).toBeUndefined();
    expect(record.attach?.ok).toBe(true);
    expect(record.action).toMatchObject({
      ok: true,
      action: "browser_type",
      snapshotInvalidated: true,
      completion: { status: "completed" },
    });
    expect(record.after?.ok).toBe(true);
    expect(record.after?.state?.snapshotId).not.toBe(record.beforeSnapshot);
    expect(record.after?.state?.dom).toContain("astra");
  }, 60_000);
});
