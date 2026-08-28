import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const DEFAULT_REPORT_TIMEOUT_MS = 60_000;

export function findChrome(): string | null {
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

interface LoggedRequest {
  t: number;
  path: string;
  query: string;
}

interface ReportSlot {
  ready: unknown[];
}

export interface Mv3HarnessOptions {
  // Page scheduled by the test-only background wrapper. Its script drives
  // every scenario through chrome.runtime.sendMessage and posts records back.
  // It receives the fixture origin because the harness owns the local port.
  driverJs: (origin: string) => string;
  driverHtmlName?: string;
  // Serves test-controlled GET routes (driver state, fixtures) before the
  // harness defaults. Return undefined to fall through.
  onFetch?: (url: URL) => Response | undefined;
}

export interface Mv3Harness {
  origin: string;
  browser: Browser;
  report<T = Record<string, unknown>>(label: string, timeoutMs?: number): Promise<T>;
  latestReport<T = Record<string, unknown>>(label: string, timeoutMs?: number): Promise<T | null>;
  counts(): Record<string, number>;
  sawPath(suffix: string): boolean;
  requestsWithQuery(predicate: (query: URLSearchParams) => boolean): { t: number; path: string }[];
  close(): Promise<void>;
}

// Builds one unpacked extension copy plus its local fixture origin, launches
// real Chrome against it, waits for the MV3 service worker target, then drops
// the controlling CDP session so the worker owns its debugger attachments.
export async function createMv3Harness(options: Mv3HarnessOptions): Promise<Mv3Harness> {
  const distDir = join(import.meta.dir, "..", "..", "dist");
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Chrome not found. Set PUPPETEER_EXECUTABLE_PATH.");
  }
  if (!existsSync(distDir)) {
    throw new Error("dist/ is missing. Run `bun run build` before this test.");
  }

  const driverHtmlName = options.driverHtmlName ?? "mv3-driver.html";
  const tempRoot = await mkdtemp(join(tmpdir(), "astra-mv3-worker-"));
  const extension = join(tempRoot, "extension");
  await cp(distDir, extension, { recursive: true });

  const requests: LoggedRequest[] = [];
  const reportSlots = new Map<string, ReportSlot>();

  function slotFor(label: string): ReportSlot {
    const existing = reportSlots.get(label);
    if (existing) {
      return existing;
    }
    const slot: ReportSlot = { ready: [] };
    reportSlots.set(label, slot);
    return slot;
  }

  let stopped = false;
  const server = Bun.serve({
    port: 0,
    async fetch(request, upgradeServer) {
      const url = new URL(request.url);
      if (request.method === "GET" && options.onFetch) {
        const custom = options.onFetch(url);
        if (custom !== undefined) {
          return custom;
        }
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
          },
        });
      }
      if (request.method === "POST") {
        const body: unknown = await request.json();
        const record = typeof body === "object" && body !== null && "record" in body ? body.record : {};
        const label =
          typeof body === "object" && body !== null && "label" in body && typeof body.label === "string"
            ? body.label
            : "";
        const slot = slotFor(label);
        slot.ready.push(record ?? {});
        return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
      }
      if (url.pathname === "/ws") {
        const upgraded = upgradeServer.upgrade(request);
        return upgraded ? undefined : new Response("upgrade failed", { status: 500 });
      }
      requests.push({ t: Date.now(), path: url.pathname, query: url.search });
      return new Response(await bodyFor(url), {
        headers: { "content-type": contentTypeFor(url.pathname), "cache-control": "no-store" },
      });
    },
    websocket: {
      open() {},
      message() {},
    },
  });

  async function bodyFor(url: URL): Promise<string | Uint8Array> {
    const pathname = url.pathname;
    if (pathname === "/" || pathname.startsWith("/fixture")) {
      return Bun.file(join(FIXTURES_DIR, "browser-action-waits.html")).text();
    }
    if (pathname === "/child.html") {
      return Bun.file(join(FIXTURES_DIR, "browser-frame-child.html")).text();
    }
    if (pathname === "/browser-frame-grandchild.html") {
      return Bun.file(join(FIXTURES_DIR, "browser-frame-grandchild.html")).text();
    }
    if (pathname === "/redirect-trap") {
      return [
        "<!doctype html><html><head><title>Redirect trap</title></head><body>",
        "<script>setTimeout(function () { location.assign('about:blank'); }, 300);</script>",
        "</body></html>",
      ].join("");
    }
    if (pathname === "/docs") {
      return "<!doctype html><html><head><title>Docs</title></head><body><h1>Docs</h1></body></html>";
    }
    if (pathname === "/respond") {
      const query = url.searchParams.get("q") ?? "";
      const delay = /^delay-(\d+)-/.exec(query);
      if (delay) {
        await Bun.sleep(Number(delay[1]));
      } else if (query === "fail") {
        await Bun.sleep(250);
      }
      return JSON.stringify([`${query} result`]);
    }
    return "<!doctype html><html><head><title>MV3 harness</title></head><body></body></html>";
  }

  function contentTypeFor(pathname: string): string {
    if (pathname === "/respond") {
      return "application/json";
    }
    if (pathname.endsWith(".png")) {
      return "image/png";
    }
    return "text/html";
  }

  // Pulls one posted record for the label. Arrivals are buffered before or
  // during the wait, so late consumers always see their phase's record and no
  // timed-out wait can steal a future one.
  async function report<T>(label: string, timeoutMs = DEFAULT_REPORT_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const slot = slotFor(label);
      if (slot.ready.length > 0) {
        return slot.ready.shift() as T;
      }
      await Bun.sleep(50);
    }
    throw new Error(`No report for "${label}". Received labels: [${[...reportSlots.keys()].join(", ")}]`);
  }

  async function latestReport<T>(label: string, timeoutMs: number): Promise<T | null> {
    try {
      return await report<T>(label, timeoutMs);
    } catch {
      return null;
    }
  }

  function counts(): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const entry of requests) {
      totals[entry.path] = (totals[entry.path] ?? 0) + 1;
    }
    return totals;
  }

  function sawPath(suffix: string): boolean {
    return requests.some((entry) => entry.path.includes(suffix));
  }

  function requestsWithQuery(
    predicate: (query: URLSearchParams) => boolean,
  ): { t: number; path: string }[] {
    return requests
      .filter((entry) => predicate(new URLSearchParams(entry.query)))
      .map(({ t, path }) => ({ t, path }));
  }

  const origin = `http://127.0.0.1:${server.port}`;

  const manifestPath = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  manifest.background.service_worker = "test-background.js";
  await writeFile(manifestPath, JSON.stringify(manifest));

  // Only the temporary copy widens permissions or schedules the driver. The
  // shipped manifest and shipped service worker stay exactly as built.
  await writeFile(
    join(extension, driverHtmlName),
    '<!doctype html><meta charset="utf-8"><script src="' +
      driverHtmlName.replace(/\.html$/, ".js") +
      '"></script>',
  );
  await writeFile(
    join(extension, driverHtmlName.replace(/\.html$/, ".js")),
    options.driverJs(origin),
  );
  await writeFile(
    join(extension, "test-background.js"),
    [
      'import "./background.js";',
      "// One driver per browser session: a revived worker must not spawn a",
      "// second run that races the first one's reports. Existing-tab lookup",
      "// keeps this guard free of extra manifest permissions.",
      "(async () => {",
      "  const driverUrl = chrome.runtime.getURL(" + JSON.stringify(driverHtmlName) + ");",
      "  setTimeout(async () => {",
      "    try {",
      "      const existing = await chrome.tabs.query({ url: driverUrl });",
      "      if (existing.length > 0) return;",
      "      void chrome.tabs.create({ url: driverUrl, active: true });",
      "    } catch {}",
      "  }, 1000);",
      "})();",
    ].join("\n"),
  );

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      enableExtensions: [extension],
      userDataDir: join(tempRoot, "profile"),
      // One properly sized window keeps whole-fixture interactions inside
      // viewportBounds; rendered refs require viewport intersection.
      args: ["--no-sandbox", "--window-size=1440,1600"],
    });
    const deadline = Date.now() + 15_000;
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
    await browser.disconnect();
  } catch (error) {
    browser?.process()?.kill();
    server.stop(true);
    await rm(tempRoot, { recursive: true, force: true });
    stopped = true;
    throw error;
  }

  return {
    origin,
    browser,
    report,
    latestReport,
    counts,
    sawPath,
    requestsWithQuery,
    async close(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      browser?.process()?.kill();
      server.stop(true);
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}
