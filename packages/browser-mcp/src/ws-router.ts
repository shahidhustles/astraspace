// WebSocket router: the extension's outbound connection into the MCP server.
//
// The extension dials US (never the reverse), which is what makes cloud
// deployment work — no inbound firewall hole on the user's machine. Once
// registered, the extension answers `tool_request` messages with
// `tool_response` / `tool_error`, correlated by id, exactly the contract the
// vendored open-claude-in-chrome background.js already speaks to its native
// host.

import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { REQUEST_TIMEOUT_MS, WS_PATH } from "./config";
import { SessionMap } from "./session-map";

export interface ToolRequest {
  type: "tool_request";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResponse {
  type: "tool_response";
  id: string;
  result: unknown;
}

export interface ToolError {
  type: "tool_error";
  id: string;
  error: string;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserNotConnectedError extends Error {
  readonly code = "browser_not_connected";

  constructor(sessionId: string) {
    super(
      `Browser extension is not connected for session "${sessionId}". Open the extension and make sure it is running, then retry.`,
    );
    this.name = "BrowserNotConnectedError";
  }
}

export class ExtensionDisconnectedError extends Error {
  readonly code = "extension_disconnected";

  constructor() {
    super(
      "Browser extension disconnected while the request was in flight. The action may have ALREADY taken effect in the browser; verify the page state before retrying.",
    );
    this.name = "ExtensionDisconnectedError";
  }
}

export class ToolCallTimedOutError extends Error {
  readonly code = "tool_call_timed_out";

  constructor(tool: string, timeoutMs: number) {
    super(`Tool "${tool}" did not answer within ${timeoutMs}ms.`);
    this.name = "ToolCallTimedOutError";
  }
}

export class WsRouter {
  readonly sessions = new SessionMap();

  private readonly server: WebSocketServer;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sendListeners = new Set<(msg: ToolRequest) => void>();

  constructor(server: WebSocketServer) {
    this.server = server;
  }

  /** Bind the router to an already-created WebSocketServer. Call once. */
  attach(): void {
    this.server.on("connection", (socket) => this.handleConnection(socket));
  }

  /** Subscribe to outbound tool_requests (used by the MCP server). */
  onToolRequest(listener: (msg: ToolRequest) => void): () => void {
    this.sendListeners.add(listener);
    return () => this.sendListeners.delete(listener);
  }

  async callTool(sessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new BrowserNotConnectedError(sessionId);
    }
    const id = randomUUID();
    const request: ToolRequest = { type: "tool_request", id, tool, args };

    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolCallTimedOutError(tool, REQUEST_TIMEOUT_MS));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });

      session.socket.send(JSON.stringify(request), (error) => {
        if (error) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.reject(new ExtensionDisconnectedError());
          }
        }
      });
      for (const listener of this.sendListeners) listener(request);
    });

    return result;
  }

  close(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.server.close();
  }

  private handleConnection(socket: WebSocket): void {
    socket.on("message", (raw) => this.handleMessage(socket, raw));
    socket.on("close", () => this.handleClose(socket));
    socket.on("error", () => this.handleClose(socket));
  }

  private handleMessage(socket: WebSocket, raw: WebSocket.RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "malformed JSON" }));
      return;
    }
    if (!isRecord(msg)) return;

    if (msg.type === "register") {
      if (typeof msg.sessionId === "string" && msg.sessionId.length > 0) {
        this.sessions.register(msg.sessionId, socket);
        socket.send(JSON.stringify({ type: "registered", sessionId: msg.sessionId }));
      } else {
        socket.send(JSON.stringify({ type: "error", error: "register requires a sessionId" }));
      }
      return;
    }

    if (msg.type === "tool_response" || msg.type === "tool_error") {
      if (typeof msg.id !== "string") return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.type === "tool_error") {
        entry.reject(new Error(String(msg.error ?? "Tool execution failed")));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Unknown message types are ignored (heartbeats from the extension etc.).
  }

  private handleClose(socket: WebSocket): void {
    this.sessions.unregister(socket);
    // Any request still waiting on this socket can never be answered.
    // Correlation is by id; the pending map does not track sockets, so fail
    // every outstanding request — they belong to whichever socket just died.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(new ExtensionDisconnectedError());
    }
  }
}

export function createWsServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

export { WS_PATH };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
