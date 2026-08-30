#!/usr/bin/env bash
# Smoke test for the browser-mcp server over Streamable HTTP.
#
# Proves the "if it works over HTTP it works anywhere" contract:
#   1. initialize  -> captures Mcp-Session-Id
#   2. tools/list  -> returns the browser tools
#   3. tools/call  -> with no extension connected, returns a clean
#                     browser_not_connected error (not a crash)
#
# Usage: start the server first (`bun src/index.ts`), then run this script.

set -euo pipefail

BASE="${BROWSER_MCP_URL:-http://localhost:8787/mcp}"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"

echo "==> initialize"
INIT_RESP=$(curl -s -i -X POST "$BASE" -H "$CT" -H "$ACCEPT" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}')
echo "$INIT_RESP" | head -1
SESSION=$(echo "$INIT_RESP" | grep -i '^mcp-session-id:' | tr -d '\r' | awk '{print $2}')
if [ -z "$SESSION" ]; then
  echo "FAIL: no Mcp-Session-Id returned"
  exit 1
fi
echo "    session=$SESSION"

echo "==> tools/list"
TOOLS=$(curl -s -X POST "$BASE" -H "$CT" -H "$ACCEPT" -H "Mcp-Session-Id: $SESSION" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
COUNT=$(echo "$TOOLS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['result']['tools']))" 2>/dev/null || echo 0)
echo "    tool count: $COUNT"
if [ "$COUNT" -lt 15 ]; then
  echo "FAIL: expected at least 15 tools, got $COUNT"
  exit 1
fi

echo "==> tools/call (read_page with tabId 1)"
RESULT=$(curl -s -X POST "$BASE" -H "$CT" -H "$ACCEPT" -H "Mcp-Session-Id: $SESSION" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_page","arguments":{"tabId":1}}}')
echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['result']; print('    isError:', r.get('isError')); print('    text:', r['content'][0]['text'][:120])"
# Accept either: no extension (browser_not_connected) or a routed response from
# the connected extension (e.g. "Tab 1 is not in the MCP group").
if ! echo "$RESULT" | grep -qE "browser_not_connected|not in the MCP group|Could not generate|Error"; then
  echo "FAIL: expected a browser error, got unexpected response"
  exit 1
fi

echo "==> ALL SMOKE TESTS PASSED"
