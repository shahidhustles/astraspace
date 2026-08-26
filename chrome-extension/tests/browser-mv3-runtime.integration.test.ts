import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import puppeteer, { type Browser } from "puppeteer-core";

const ATTACH_MESSAGE = "browser.attach-active-tab";
const OBSERVE_MESSAGE = "browser.observe-selected-tab";
const REFRESH_ACTION = "browser.action";

function findChrome(): string | null {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const cacheRoot = join(homedir(), ".cache", "puppeteer");
  if (!existsSync(cacheRoot)) {
    return null;
  }
  const executables = new Set(["chrome", "headless_shell", "Google Chrome for Testing"]);
  for (const match of new Bun.Glob("**/*").scanSync({ cwd: cacheRoot, onlyFiles: true })) {
    if (executables.has(match.split("/").pop() ?? "")) {
      return join(cacheRoot, match);
    }
  }
  return null;
}

interface SmokeReport {
  attach?: { ok: boolean; tabId?: number; error?: unknown };
  observe?: {
    ok: boolean;
    state?: { refs: unknown[]; snapshotId?: string; dom?: string };
    error?: unknown;
  };
  refresh?: { ok: boolean; action?: string; error?: unknown };
  error?: string;
}

describe("browser runtime inside a real unpacked MV3 service worker", () => {
  const distDir = join(import.meta.dir, "..", "dist");
  const chromePath = findChrome();

  let browser: Browser | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let tempRoot: string | null = null;

  afterAll(async () => {
    browser?.process()?.kill();
    server?.stop(true);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("attach, observe, and refresh work through chrome.runtime.sendMessage", async () => {
    if (!existsSync(distDir)) {
      throw new Error("dist/ is missing. Run `bun run build` before this test.");
    }
    const executablePath = (() => {
      if (!chromePath) {
        throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
      }
      return chromePath;
    })();

    tempRoot = await mkdtemp(join(tmpdir(), "astra-mv3-smoke-"));
    const extension = join(tempRoot, "extension");
    await cp(distDir, extension, { recursive: true });

    let resolveReport: (value: SmokeReport) => void = () => {};
    const reportPromise = new Promise<SmokeReport>((resolve) => {
      resolveReport = resolve;
    });
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "POST") {
          resolveReport((await request.json()) as SmokeReport);
          return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
        }
        return new Response(
          `<!doctype html>
            <html>
              <head><title>MV3 smoke</title></head>
              <body>
                <label for="who">Who</label>
                <input id="who" type="text" />
                <button id="go" type="button">Go</button>
                <a id="docs" href="/docs">Docs</a>
              </body>
            </html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const fixtureUrl = `http://127.0.0.1:${server.port}/fixture`;
    const reportUrl = `http://127.0.0.1:${server.port}/report`;

    // The shipped manifest stays untouched. Only this temporary copy grants
    // test-only access and schedules the in-extension smoke page.
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["<all_urls>"];
    manifest.background.service_worker = "test-background.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      join(extension, "mv3-smoke.html"),
      '<!doctype html><script src="mv3-smoke.js"></script>',
    );
    await writeFile(
      join(extension, "mv3-smoke.js"),
      `(async () => {
        try {
          const tab = await chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true });
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const current = await chrome.tabs.get(tab.id);
            if (current.status === "complete") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          const attach = await chrome.runtime.sendMessage({ type: ${JSON.stringify(ATTACH_MESSAGE)} });
          const observe = await chrome.runtime.sendMessage({ type: ${JSON.stringify(OBSERVE_MESSAGE)} });
          const refresh = await chrome.runtime.sendMessage({
            type: ${JSON.stringify(REFRESH_ACTION)},
            action: "browser_refresh",
            input: {},
          });
          await fetch(${JSON.stringify(reportUrl)}, {
            method: "POST",
            body: JSON.stringify({ attach, observe, refresh }),
          });
        } catch (error) {
          await fetch(${JSON.stringify(reportUrl)}, {
            method: "POST",
            body: JSON.stringify({ error: String(error) }),
          });
        }
      })();`,
    );
    await writeFile(
      join(extension, "test-background.js"),
      `
import "./background.js";
setTimeout(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("mv3-smoke.html"), active: true });
}, 1000);
`,
    );

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      enableExtensions: [extension],
      userDataDir: join(tempRoot, "profile"),
      args: ["--no-sandbox"],
    });

    const deadline = Date.now() + 10_000;
    while (
      !browser
        .targets()
        .some(
          (target) =>
            target.type() === "service_worker" && target.url().startsWith("chrome-extension://"),
        )
    ) {
      if (Date.now() >= deadline) {
        throw new Error("MV3 service worker never started");
      }
      await Bun.sleep(50);
    }

    // Drop the controlling CDP session so the worker owns its debugger attachment.
    // The Chrome process itself must stay alive to serve the extension.
    await browser.disconnect();

    const report = await Promise.race([
      reportPromise,
      Bun.sleep(20_000).then(() => {
        throw new Error("smoke page never reported");
      }),
    ]);

    expect(report.error).toBeUndefined();
    expect(report.attach?.ok).toBe(true);
    expect(report.observe?.ok).toBe(true);
    expect(report.observe?.state?.refs?.length ?? 0).toBeGreaterThan(0);
    expect(report.observe?.state?.snapshotId).toBeTruthy();
    expect(report.refresh).toEqual({
      ok: true,
      action: "browser_refresh",
      tabId: report.attach?.tabId,
      url: fixtureUrl,
      snapshotInvalidated: true,
      data: { kind: "refresh" },
    });
  }, 60_000);
});
