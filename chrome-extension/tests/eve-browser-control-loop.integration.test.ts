import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "eve/client";
import type { MessageStreamEvent } from "eve/client";
import { createMv3Harness, findChrome, type Mv3Harness } from "./helpers/mv3-worker-harness";
import { EVE_HOST } from "../src/lib/eve-config";

// The fixture model id is authored in packages/agent-core; the extension
// package does not depend on the agent, so the id is restated here.
const FIXTURE_MODEL_ID = "browser-observe-fixture";
const FIXTURE_PATH = join(import.meta.dir, "fixtures", "eve-browser-control.html");

// Driver staging flags. The test flips them; the driver page polls them over
// HTTP and performs the corresponding chrome.* work in the extension context.
const driverState: {
  sessionId: string | null;
  attach: boolean;
  openRerender: boolean;
  restartWorker: boolean;
  closeTab: boolean;
} = {
  sessionId: null,
  attach: false,
  openRerender: false,
  restartWorker: false,
  closeTab: false,
};

let harness: Mv3Harness | null = null;
let eveProc: ReturnType<typeof Bun.spawn> | null = null;
let fixtureSession: Awaited<ReturnType<Client["sessions"]["create"]>>["session"] | null = null;

function jsonRoute(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function isActionResult(
  event: unknown,
): event is { type: "action.result"; data: { status: string; result: { toolName: string; output: unknown } } } {
  if (typeof event !== "object" || event === null) return false;
  return (event as { type?: unknown }).type === "action.result";
}

function actionEvents(result: { events: MessageStreamEvent[] }) {
  return result.events.filter(isActionResult).filter((event) => {
    const name = event.data.result?.toolName ?? "";
    return name.startsWith("browser_");
  });
}

function toolNames(result: { events: MessageStreamEvent[] }): string[] {
  return actionEvents(result).map((event) => event.data.result?.toolName ?? "");
}

function completedNames(result: { events: MessageStreamEvent[] }): string[] {
  return actionEvents(result)
    .filter((event) => event.data.status === "completed")
    .map((event) => event.data.result?.toolName ?? "");
}

function sendPrompt(prompt: string) {
  if (fixtureSession === null) throw new Error("fixture session was not created");
  return fixtureSession
    .send(prompt, {
      clientContext: { astraModelId: FIXTURE_MODEL_ID },
    })
    .then((turn) => turn.result());
}

beforeAll(async () => {
  if (!findChrome()) {
    throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
  }
  try {
    await fetch(`${EVE_HOST}/`, { signal: AbortSignal.timeout(1500) });
    throw new Error("Port 2000 is already in use. Stop any running `eve dev` before this test.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("already in use")) throw error;
  }

  const agentRoot = join(import.meta.dir, "..", "..", "packages", "agent-core");
  eveProc = Bun.spawn(["bun", "x", "eve", "dev", "--no-ui", "--port", "2000"], {
    cwd: agentRoot,
    // NODE_ENV=test would make eve replace authored models with its own
    // runtime mock adapter; pin development so the authored fixture model
    // under ASTRA_FIXTURE_MODELS is the one that answers.
    env: { ...process.env, NODE_ENV: "development", ASTRA_FIXTURE_MODELS: "1" } as Record<string, string>,
    stdout: "inherit",
    stderr: "inherit",
  });

  const client = new Client({ host: EVE_HOST });
  const healthDeadline = Date.now() + 120_000;
  while (true) {
    if (Date.now() >= healthDeadline) {
      throw new Error("eve dev never became healthy on http://127.0.0.1:2000");
    }
    try {
      await client.health();
      break;
    } catch {
      await Bun.sleep(500);
    }
  }

  const extensionRoot = join(import.meta.dir, "..");
  if (!existsSync(join(extensionRoot, "dist", "background.js"))) {
    const built = spawnSync("bun", ["run", "build:extension"], {
      cwd: extensionRoot,
      stdio: "inherit",
    });
    if (built.status !== 0) {
      throw new Error("bun run build:extension failed");
    }
  }

  harness = await createMv3Harness({
    driverHtmlName: "eve-loop-driver.html",
    onFetch: (url) => {
      if (url.pathname === "/session") return jsonRoute({ sessionId: driverState.sessionId });
      if (url.pathname === "/state") {
        return jsonRoute({
          attach: driverState.attach,
          openRerender: driverState.openRerender,
          restartWorker: driverState.restartWorker,
          closeTab: driverState.closeTab,
        });
      }
      if (url.pathname === "/eve-loop") {
        return new Response(Bun.file(FIXTURE_PATH), {
          headers: { "content-type": "text/html", "cache-control": "no-store" },
        });
      }
      return undefined;
    },
    driverJs: (origin) => `(async () => {
      const S = ${JSON.stringify(origin)};
      const post = (label, record) => fetch(S + "/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, record }),
      }).catch(() => {});
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let boundSession = null;
      let attached = false;
      let rerenderOpened = false;
      let restarted = false;
      let closed = false;
      while (true) {
        try {
          const sessionState = await fetch(S + "/session").then((r) => r.json());
          const boundCandidate = sessionState.sessionId;
          if (boundCandidate && boundCandidate !== boundSession) {
            boundSession = boundCandidate;
            try {
              await chrome.runtime.sendMessage({ type: "astra/eve-session-changed", sessionId: boundCandidate });
            } catch {}
            let tokenStored = false;
            const bindDeadline = Date.now() + 5000;
            while (Date.now() < bindDeadline) {
              const stored = await chrome.storage.session.get("astra.browser.connection");
              const connection = stored["astra.browser.connection"];
              if (connection && connection.sessionId === boundCandidate) {
                tokenStored = true;
                break;
              }
              await sleep(100);
            }
            await post("bound", { sessionId: boundCandidate, tokenStored });
          }

          const state = await fetch(S + "/state").then((r) => r.json());
          if (state.attach && !attached) {
            attached = true;
            const tab = await chrome.tabs.create({ url: S + "/eve-loop", active: true });
            const loadDeadline = Date.now() + 10000;
            while (Date.now() < loadDeadline) {
              const current = await chrome.tabs.get(tab.id);
              if (current.status === "complete") break;
              await sleep(100);
            }
            const attach = await chrome.runtime.sendMessage({ type: "browser.attach-active-tab" });
            await post("attached", attach);
            const panelObserve = await chrome.runtime.sendMessage({ type: "browser.observe-selected-tab" });
            await post("panel-observe", {
              ok: panelObserve && panelObserve.ok,
              error: panelObserve && panelObserve.error,
              hasDom: Boolean(panelObserve && panelObserve.state && panelObserve.state.dom),
            });
          }

          if (state.openRerender && !rerenderOpened) {
            rerenderOpened = true;
            const tab = await chrome.tabs.create({ url: S + "/eve-loop?mode=rerender", active: true });
            const loadDeadline = Date.now() + 10000;
            while (Date.now() < loadDeadline) {
              const current = await chrome.tabs.get(tab.id);
              if (current.status === "complete") break;
              await sleep(100);
            }
            const attach = await chrome.runtime.sendMessage({ type: "browser.attach-active-tab" });
            await post("rerender-attached", attach);
          }

          if (state.restartWorker && !restarted) {
            restarted = true;
            // Reloading the extension terminates the service worker and boots
            // it again. chrome.storage.session survives, so resumeFromStorage
            // rebinds the same Eve session with the same connection token.
            await chrome.runtime.reload();
            const deadline = Date.now() + 15000;
            let alive = false;
            while (Date.now() < deadline) {
              try {
                const ping = await chrome.runtime.sendMessage({ type: "browser.observe-selected-tab" });
                if (ping && ping.error) break;
                alive = true;
                break;
              } catch {
                await sleep(200);
              }
            }
            await post("worker-restarted", { alive });
          }

          if (state.closeTab && !closed) {
            closed = true;
            const tabs = await chrome.tabs.query({ active: true });
            for (const tab of tabs) {
              if (tab.id !== undefined) await chrome.tabs.remove(tab.id);
            }
            await post("tab-closed", { ok: true });
          }
        } catch (error) {
          await post("driver-error", { error: String(error) });
        }
        await sleep(300);
      }
    })();`,
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
  eveProc?.kill();
  await eveProc?.exited;
}, 30_000);

describe("the complete eve browser loop through the built worker", () => {
  test("creates a fixture session and binds it to the extension", async () => {
    if (harness === null) throw new Error("harness missing");
    const client = new Client({ host: EVE_HOST });
    const { session, response } = await client.sessions.create({
      message: "ping",
      clientContext: { astraModelId: FIXTURE_MODEL_ID },
    });
    const ping = await response.result();
    expect(ping.status).not.toBe("failed");
    expect(ping.message).toContain("fixture-ready");

    fixtureSession = session;
    driverState.sessionId = response.sessionId;
    const bound = await harness.report<{ sessionId: string; tokenStored: boolean }>("bound", 20_000);
    expect(bound.tokenStored).toBe(true);
  }, 60_000);

  test("observes, mutates, and completes the multi-field form through the worker", async () => {
    if (harness === null) throw new Error("harness missing");
    driverState.attach = true;
    const attached = await harness.report<{ ok: boolean; tabId?: number }>("attached", 20_000);
    expect(attached.ok).toBe(true);
    expect(attached.tabId).toBeNumber();

    const result = await sendPrompt("Complete the loop form");
    expect(result.status).not.toBe("failed");
    expect(result.message).toContain("FORM_OK");
    expect(result.message).toContain("Form success");
    expect(result.message).toContain("Submitted by Astra from Oslo, greenland.");

    const names = toolNames(result);
    expect(names).toContain("browser_observe");
    expect(names).toContain("browser_type");
    expect(names).toContain("browser_select_option");
    expect(names).toContain("browser_click");
    expect(completedNames(result)).toContain("browser_click");

    // The final observation carries the visible success evidence.
    const finalObserve = actionEvents(result)
      .filter((event) => event.data.result?.toolName === "browser_observe")
      .pop();
    expect(finalObserve).toBeDefined();
    const finalDom = JSON.stringify(finalObserve?.data.result?.output ?? "");
    expect(finalDom).toContain("Form success");
    expect(finalDom).toContain("Submitted by Astra from Oslo, greenland.");

    // Private grounding fields and screenshot payloads never reach the model.
    const serialized = JSON.stringify(result.events);
    for (const privateField of ["backendNodeId", "domPath", "frameLineage", "cssSegments", "xpathSegments"]) {
      expect(serialized).not.toContain(privateField);
    }
    expect(serialized).not.toContain("/9j/");
  }, 90_000);

  test("resumes the same session after a worker restart without page payloads in storage", async () => {
    if (harness === null) throw new Error("harness missing");
    driverState.restartWorker = true;
    const restarted = await harness.report<{ alive: boolean }>("worker-restarted", 30_000);
    expect(restarted.alive).toBe(true);

    // Same session, fresh prompt after the worker came back.
    const result = await sendPrompt("Wait for the form result");
    expect(result.status).not.toBe("failed");
    expect(result.message).toContain("WAIT_FORM_OK");

    // Extension storage holds session identity and transport metadata only:
    // no DOM, screenshots, or tool payloads.
    const stored = await harness.report<{
      keys: string[];
      hasDom: boolean;
      hasScreenshot: boolean;
    }>("storage-scan", 20_000);
    expect(stored.hasDom).toBe(false);
    expect(stored.hasScreenshot).toBe(false);
    const joined = stored.keys.join(",");
    expect(joined).toContain("astra.eve.session");
    expect(joined).toContain("astra.browser.connection");
  }, 90_000);

  test("rejects a stale ref and never replays the mutation", async () => {
    if (harness === null) throw new Error("harness missing");
    driverState.openRerender = true;
    const rerenderAttached = await harness.report<{ ok: boolean }>("rerender-attached", 20_000);
    expect(rerenderAttached.ok).toBe(true);

    // The fixture was not yet submitted in the rerender tab, so type once;
    // after the submit's rerender the old ref becomes stale and the second
    // type must be rejected. The model observes again and uses a fresh ref.
    const result = await sendPrompt("Prove the stale ref is not reused");
    expect(result.status).not.toBe("failed");
    expect(result.message).toContain("STALE_REF_PROVEN");

    const staleRefs = actionEvents(result).filter(
      (event) => event.data.result?.toolName === "browser_type" && event.data.status === "failed",
    );
    expect(staleRefs.length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  test("settles a typed lifecycle failure and recovers on the same session", async () => {
    if (harness === null) throw new Error("harness missing");
    driverState.closeTab = true;
    const closed = await harness.report<{ ok: boolean }>("tab-closed", 20_000);
    expect(closed.ok).toBe(true);

    const failedTurn = await sendPrompt("Wait for the form result");
    expect(failedTurn.status).not.toBe("failed");
    expect(failedTurn.message).toContain("LOOP_UNAVAILABLE");
    expect(failedTurn.message).toMatch(/code=(selected_tab_unavailable|browser_unavailable)/);

    // Recover: open a fresh fixture tab and the same session succeeds again.
    driverState.attach = false;
    driverState.openRerender = false;
    driverState.restartWorker = false;
    driverState.closeTab = false;
    driverState.attach = true;
    await harness.report<{ ok: boolean }>("attached", 20_000);
    const recovered = await sendPrompt("Wait for the form result");
    expect(recovered.status).not.toBe("failed");
    expect(recovered.message).toContain("WAIT_FORM_OK");
  }, 90_000);
});
