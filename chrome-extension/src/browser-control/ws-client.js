// WebSocket transport for the extension, replacing the native messaging host.
//
// The extension dials the MCP server's WebSocket router OUTBOUND (the cloud
// deployment needs no inbound hole on the user's machine). Message contract
// mirrors what the fork's native host spoke to background.js:
//
//   server -> extension: { type: "tool_request", id, tool, args }
//   extension -> server: { type: "tool_response", id, result }
//                         { type: "tool_error", id, error }
//
// On open we send { type: "register", sessionId } so the router maps this
// extension to a session. A heartbeat every 15s keeps both the socket and the
// MV3 service worker alive. Reconnect with backoff; a suspended SW just
// re-connects on the next wake.

const DEFAULT_URL = "ws://localhost:8787/ws";
const HEARTBEAT_MS = 15000;
const RECONNECT_MS = 250;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let closed = false;
let sessionId = "default";

const messageListeners = new Set();

export function initWsClient({ url = DEFAULT_URL, session = "default" } = {}) {
  sessionId = session;
  connect();
}

export function onWsMessage(listener) {
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

export function isWsConnected() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

export function wsSend(msg) {
  if (!isWsConnected()) return false;
  try {
    socket.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function connect() {
  if (closed) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) return;

  const url = (typeof BROWSER_MCP_WS_URL !== "undefined" && BROWSER_MCP_WS_URL) || DEFAULT_URL;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    wsSend({ type: "register", sessionId });
    startHeartbeat();
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    for (const listener of messageListeners) listener(msg);
  };
  ws.onclose = () => {
    socket = null;
    stopHeartbeat();
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function scheduleReconnect() {
  if (closed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!isWsConnected()) return;
    wsSend({ type: "heartbeat", t: Date.now() });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function closeWsClient() {
  closed = true;
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {}
    socket = null;
  }
}
