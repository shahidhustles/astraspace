import type { ClientSessionState } from "eve/client";

const EVE_SESSION_KEY = "astra.eve.session";
const BROWSER_CONNECTION_KEY = "astra.browser.connection";

export type StoredEveSession = ClientSessionState;

export interface StoredBrowserConnection {
  sessionId: string;
  connectionToken: string;
  generation: number;
}

export interface EveSessionChangedMessage {
  type: "astra/eve-session-changed";
  sessionId: string;
}

export async function readStoredEveSession(): Promise<StoredEveSession | null> {
  const stored = await chrome.storage.session.get(EVE_SESSION_KEY);
  const session = stored[EVE_SESSION_KEY] as Partial<StoredEveSession> | undefined;
  if (
    session === undefined ||
    typeof session.sessionId !== "string" ||
    session.sessionId.length === 0 ||
    typeof session.streamIndex !== "number"
  ) {
    return null;
  }
  return { sessionId: session.sessionId, streamIndex: session.streamIndex };
}

export async function storeEveSession(session: StoredEveSession | null): Promise<void> {
  if (session === null) {
    await chrome.storage.session.remove(EVE_SESSION_KEY);
    return;
  }
  await chrome.storage.session.set({ [EVE_SESSION_KEY]: session });
}

export async function readStoredBrowserConnection(): Promise<StoredBrowserConnection | null> {
  const stored = await chrome.storage.session.get(BROWSER_CONNECTION_KEY);
  const connection = stored[BROWSER_CONNECTION_KEY] as Partial<StoredBrowserConnection> | undefined;
  if (
    connection === undefined ||
    typeof connection.sessionId !== "string" ||
    typeof connection.connectionToken !== "string" ||
    connection.connectionToken.length === 0 ||
    typeof connection.generation !== "number"
  ) {
    return null;
  }
  return {
    sessionId: connection.sessionId,
    connectionToken: connection.connectionToken,
    generation: connection.generation,
  };
}

export async function storeBrowserConnection(connection: StoredBrowserConnection): Promise<void> {
  await chrome.storage.session.set({ [BROWSER_CONNECTION_KEY]: connection });
}

export async function clearBrowserConnection(): Promise<void> {
  await chrome.storage.session.remove(BROWSER_CONNECTION_KEY);
}

export function isEveSessionChangedMessage(value: unknown): value is EveSessionChangedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "astra/eve-session-changed" &&
    typeof (value as { sessionId?: unknown }).sessionId === "string"
  );
}

export async function notifyEveSessionChanged(sessionId: string): Promise<void> {
  const message: EveSessionChangedMessage = { type: "astra/eve-session-changed", sessionId };
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The worker may be starting up; it reads the stored connection on wake.
  }
}
