# @astra-space/browser-mcp

A fork of [open-claude-in-chrome](https://github.com/noemica-io/open-claude-in-chrome) (MIT) — a
clean-room reimplementation of Anthropic's "Claude in Chrome" extension — packaged as a
**Streamable HTTP MCP server** with a **WebSocket router** that a Chrome extension connects to.

```
Eve (cloud or local)
   │  MCP (Streamable HTTP)
   ▼
packages/browser-mcp  ──►  WebSocket  ──►  Chrome extension  ──►  chrome.debugger  ──►  user's live tab
   (MCP server + router)                   (extension-runtime/)        (CDP)
```

The user installs **only** the extension. No Node, no native host, no daemon on their machine.

## What's in here

- `src/mcp-server.ts` — Streamable HTTP MCP server. Eve's `defineMcpClientConnection` speaks
  Streamable HTTP, so Eve can reach it locally or from the cloud.
- `src/ws-router.ts` + `src/session-map.ts` — WebSocket server the extension dials outbound
  (no inbound firewall hole needed). Correlates `tool_request` / `tool_response` by id.
- `src/tool-schemas.ts` — the 26 browser tools (read_page, computer, form_input, navigate, find,
  tab tools, etc.), ported from the fork.
- `extension-runtime/` — the vendored fork extension. `background.js` was patched to speak
  WebSocket instead of native messaging; `content.js`, the ref system, and the CDP/action layer
  are unchanged.

## The message contract

```
server → extension:  { type: "tool_request", id, tool, args }
extension → server:  { type: "tool_response", id, result }
                     { type: "tool_error", id, error }
extension → server:  { type: "register", sessionId }   (on connect)
```

## Local test

```bash
# 1. Start the server (from the repo root)
bun run --filter @astra-space/browser-mcp dev

# 2. Smoke-test the MCP contract over HTTP (no browser needed)
bun run --filter @astra-space/browser-mcp test:smoke

# 3. Unit tests (WebSocket routing with a simulated extension)
bun run --filter @astra-space/browser-mcp test

# 4. Load the extension unpacked (chrome://extensions → Developer mode → Load unpacked →
#    packages/browser-mcp/extension-runtime) and point it at the local WS. Then:
curl -X POST http://localhost:8787/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
# → capture Mcp-Session-Id, then tools/call read_page → real accessibility tree from the tab.
```

## Cloud deployment

The same server deploys unchanged. Set `BROWSER_MCP_HOST`/`BROWSER_MCP_PORT` (or bind to
`0.0.0.0` behind a TLS terminator) and point the extension at the public WebSocket URL via
`BROWSER_MCP_WS_URL` in `extension-runtime/ws-client.js` (or a build-time constant). Point Eve at
the public MCP URL via `BROWSER_MCP_URL`.

## What was removed from the fork (the transport)

- `host/mcp-server.js` (stdio MCP), `host/native-host.js` (native messaging + Unix socket),
  `host/endpoint.js`, `host/parent-watch.js`, `host/codemode/*`
- The extension's `chrome.runtime.connectNative(...)` (replaced by `ws-client.js`)

Features that depended on the native host are degraded in this build and return clear errors:
`save_to_disk`, `upload_image` staging, and the imitation-learning recorder's file writes. The
core tools (read_page, find, form_input, computer, navigate, tabs, console/network reads) work
over WebSocket.

## Current implementation (unattached)

The existing custom browser-control stack (`chrome-extension/src/browser/`, `packages/agent-core`
broker/channel/tools) is intentionally **untouched**. This package is additive; once the MCP path
is proven, the extension's connection layer can be swapped to point at this server.
