// Server configuration. Defaults target local development; every value is
// overridable through the environment so the same code deploys to the cloud
// unchanged (point the extension at the public WS URL, Eve at the public MCP
// URL).

const int = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const str = (name: string, fallback: string): string => {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
};

export const HOST = str("BROWSER_MCP_HOST", "localhost");
export const PORT = int("BROWSER_MCP_PORT", 8787);
export const MCP_PATH = str("BROWSER_MCP_PATH", "/mcp");
export const WS_PATH = str("BROWSER_WS_PATH", "/ws");

export const MCP_URL = `http://${HOST}:${PORT}${MCP_PATH}`;
export const WS_URL = `ws://${HOST}:${PORT}${WS_PATH}`;

// Time a tools/call waits for the extension to answer before failing with a
// clean error. Actions like navigate or long waits legitimately take a while;
// 60s matches the fork's own per-request timeout.
export const REQUEST_TIMEOUT_MS = 60_000;
