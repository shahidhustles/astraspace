import type { ClientSessionState } from "eve/client";

const EVE_SESSION_KEY = "astra.eve.session";

export type StoredEveSession = ClientSessionState;

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
    // The worker may be starting up; it reads the stored session on wake.
  }
}
