import { defineMcpClientConnection } from "eve/connections";

// Local browser-control MCP server (packages/browser-mcp). The extension
// connects to it over WebSocket; Eve drives the browser through these tools.
// Override BROWSER_MCP_URL when the server is deployed (the same code runs
// locally and in the cloud).
export default defineMcpClientConnection({
  url: process.env.BROWSER_MCP_URL ?? "http://localhost:8787/mcp",
  description:
    "Browser control: read the current page as an accessibility tree with element refs, click/type/scroll/navigate in the user's live Chrome tab, and manage tabs. The extension executes actions locally via chrome.debugger.",
});
