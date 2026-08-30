// Maps a connected extension socket to a session identity, so a tools/call
// routed by sessionId reaches exactly one extension. An extension registers
// itself by sending a `register` message immediately after the WebSocket
// opens:
//
//   { type: "register", sessionId: "user-browser-123" }
//
// A session owns at most one live socket: a second registration for the same
// session evicts the previous one (the extension reconnects after MV3 service
// worker suspension, so the newest socket always wins).

import type { WebSocket } from "ws";

export interface RegisteredSession {
  sessionId: string;
  socket: WebSocket;
  connectedAt: number;
}

export class SessionMap {
  private readonly bySession = new Map<string, RegisteredSession>();
  private readonly bySocket = new Map<WebSocket, RegisteredSession>();

  /** Iterate registered sessions (insertion order). Used by the router. */
  *[Symbol.iterator](): Iterator<RegisteredSession> {
    yield* this.bySession.values();
  }

  register(sessionId: string, socket: WebSocket): RegisteredSession {
    const previous = this.bySession.get(sessionId);
    if (previous && previous.socket !== socket) {
      this.evict(previous);
    }
    const record: RegisteredSession = { sessionId, socket, connectedAt: Date.now() };
    this.bySession.set(sessionId, record);
    this.bySocket.set(socket, record);
    return record;
  }

  unregister(socket: WebSocket): void {
    const record = this.bySocket.get(socket);
    if (!record) return;
    this.bySession.delete(record.sessionId);
    this.bySocket.delete(socket);
  }

  get(sessionId: string): RegisteredSession | null {
    return this.bySession.get(sessionId) ?? null;
  }

  getBySocket(socket: WebSocket): RegisteredSession | null {
    return this.bySocket.get(socket) ?? null;
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  get size(): number {
    return this.bySession.size;
  }

  private evict(record: RegisteredSession): void {
    this.bySession.delete(record.sessionId);
    this.bySocket.delete(record.socket);
    try {
      record.socket.close(4001, "superseded by a newer connection");
    } catch {
      // Socket already closed; nothing to do.
    }
  }
}
