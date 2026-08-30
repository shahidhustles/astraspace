import { describe, expect, it } from "bun:test";
import { TOOLS } from "../src/tool-schemas";

const DISABLED_TOOL_NAMES = [
  "debug",
  "debug_timings",
  "get_config",
  "read_console_messages",
  "read_network_requests",
  "set_config",
];

describe("browser MCP tool catalog", () => {
  it("does not expose debugging, configuration, or network-message tools", () => {
    const exposedToolNames = new Set(TOOLS.map(({ name }) => name));

    for (const toolName of DISABLED_TOOL_NAMES) {
      expect(exposedToolNames.has(toolName)).toBeFalse();
    }
  });
});
