import { beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");
// Static module specifiers, not object keys or strings that merely contain
// "node:". The bundle must not pull Node-only modules.
const NODE_ONLY_IMPORT = /(?:^|\n)\s*import\s+[^'"]*?from\s*["']node:|import\s*\(\s*["']node:/;
const NODE_REQUIRE = /require\(\s*["']node:/;
// Remote executable code would arrive via a dynamic import of a URL.
const REMOTE_IMPORT_URL = /\bimport\s*\(\s*["']https?:\/\//;

// The service worker entry plus every chunk it may pull in. The bridge host
// constant lives in a runtime chunk, so a background.js-only scan would miss
// the very strings this test exists to prove.
let files: string[] = [];
let bundleText = "";

beforeAll(() => {
  // Always build so the scan never looks at a stale bundle. The script name
  // in this package is `build` (root `build:extension` delegates to it).
  const built = spawnSync("bun", ["run", "build"], {
    cwd: join(import.meta.dir, ".."),
    stdio: "inherit",
  });
  if (built.status !== 0) {
    throw new Error("bun run build failed");
  }
});

describe("the built MV3 bundle stays importable outside Node", () => {
  test("the service worker bundle and its chunks are present and scanned", async () => {
    const entries = await readdir(DIST);
    expect(entries).toContain("background.js");
    const assets = await readdir(join(DIST, "assets")).catch(() => []);
    files = ["background.js", ...assets.filter((name) => name.endsWith(".js"))];
    expect(files.length).toBeGreaterThan(1);
    bundleText = (
      await Promise.all(
        files.map((name) => readFile(name === "background.js" ? join(DIST, name) : join(DIST, "assets", name), "utf8")),
      )
    ).join("\n");
    expect(bundleText.length).toBeGreaterThan(1_000);
  });

  test("contains no Node-only imports or requires", () => {
    expect(bundleText).not.toMatch(NODE_ONLY_IMPORT);
    expect(bundleText).not.toMatch(NODE_REQUIRE);
  });

  test("fetches no remote code by dynamic URL import", () => {
    expect(bundleText).not.toMatch(REMOTE_IMPORT_URL);
  });

  test("still references the local bridge host and extension origin", () => {
    // The bridge host is bundled in, not fetched from a remote source.
    expect(bundleText.includes("127.0.0.1:2000")).toBe(true);
    expect(bundleText).toContain("chrome-extension://");
  });
});
