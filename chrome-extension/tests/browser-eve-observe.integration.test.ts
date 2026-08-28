import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "eve/client";
import type { BrowserObserveState } from "@astra-space/browser-control-contract";
import { createMv3Harness, findChrome, type Mv3Harness } from "./helpers/mv3-worker-harness";
import { EVE_HOST } from "../src/lib/eve-config";

// The fixture model id is authored in packages/agent-core; the extension
// package does not depend on the agent, so the id is restated here.
const FIXTURE_MODEL_ID = "browser-observe-fixture";
const FIXTURE_PATH = join(import.meta.dir, "fixtures", "browser-observation.html");

const driverState: { sessionId: string | null; attach: boolean } = {
  sessionId: null,
  attach: false,
};

let harness: Mv3Harness | null = null;
let eveProc: ReturnType<typeof Bun.spawn> | null = null;
let fixtureSession: Awaited<ReturnType<Client["sessions"]["create"]>>["session"] | null = null;

function jsonRoute(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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
    driverHtmlName: "eve-observe-driver.html",
    onFetch: (url) => {
      if (url.pathname === "/session") return jsonRoute({ sessionId: driverState.sessionId });
      if (url.pathname === "/attach") return jsonRoute({ run: driverState.attach });
      if (url.pathname === "/fixture") {
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
      let attachDone = false;
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
          if (!attachDone) {
            const attachState = await fetch(S + "/attach").then((r) => r.json());
            if (attachState.run) {
              attachDone = true;
              const tab = await chrome.tabs.create({ url: S + "/fixture", active: true });
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

function isActionResult(
  event: unknown,
): event is { type: "action.result"; data: { status: string; result: { toolName: string; output: unknown } } } {
  if (typeof event !== "object" || event === null) return false;
  return (event as { type?: unknown }).type === "action.result";
}

function inspectTurn() {
  if (fixtureSession === null) throw new Error("fixture session was not created");
  return fixtureSession
    .send("Inspect the current page for me.", {
      clientContext: { astraModelId: FIXTURE_MODEL_ID },
    })
    .then((turn) => turn.result());
}

describe("browser_observe through the authored eve tool path", () => {
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

  test("settles a typed failure when no page is selected", async () => {
    const result = await inspectTurn();
    expect(result.status).not.toBe("failed");
    expect(result.message).toContain("BROWSER_OBSERVE_FAILED code=selected_tab_unavailable");
  }, 90_000);

  test("delivers the semantic DOM and matching JPEG into the model input", async () => {
    if (harness === null) throw new Error("harness missing");
    driverState.attach = true;
    const attached = await harness.report<{ ok: boolean; tabId?: number }>("attached", 20_000);
    expect(attached.ok).toBe(true);
    expect(attached.tabId).toBeNumber();
    const panelObserve = await harness.report<{ ok: boolean; error?: unknown }>("panel-observe", 20_000);
    expect(panelObserve.ok).toBe(true);

    const result = await inspectTurn();
    expect(result.status).not.toBe("failed");
    expect(result.message).toContain("BROWSER_OBSERVE_OK");
    expect(result.message).toContain("mediaType=image/jpeg");
    expect(result.message).toContain("jpegPrefix=/9j/");
    expect(result.message).toContain("Observation fixture");
    expect(result.message).not.toContain("snapshotId=missing");
    const jpegBytes = Number(/jpegBytes=(\d+)/.exec(result.message)?.[1] ?? 0);
    expect(jpegBytes).toBeGreaterThan(1_000);

    const observeEvents = result.events.filter(isActionResult).filter(
      (event) => event.data.result?.toolName === "browser_observe",
    );
    expect(observeEvents).toHaveLength(1);
    expect(observeEvents[0]?.data.status).toBe("completed");

    const output: unknown = observeEvents[0]?.data.result.output;
    expect(isBrowserObserveToolOutput(output)).toBe(true);
    const observation = (output as { observation: BrowserObserveState }).observation;
    expect(observation.url).toContain("/fixture");
    expect(observation.snapshot.snapshotId.length).toBeGreaterThan(0);
    expect(observation.refs.length).toBeGreaterThan(0);
    expect(observation.dom).toContain("<button");
    expect(observation.screenshot.data.startsWith("/9j/")).toBe(true);

    const serialized = JSON.stringify(output);
    for (const privateField of ["backendNodeId", "domPath", "frameLineage", "cssSegments", "xpathSegments"]) {
      expect(serialized).not.toContain(privateField);
    }
  }, 90_000);
});

function isBrowserObserveToolOutput(
  value: unknown,
): value is { ok: true; observation: BrowserObserveState; screenshot: { data: string; mediaType: string } } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.ok === true &&
    typeof record.observation === "object" &&
    record.observation !== null &&
    typeof record.screenshot === "object" &&
    record.screenshot !== null
  );
}
