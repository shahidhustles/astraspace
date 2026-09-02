import { isBoom } from "@hapi/boom";
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  isPnUser,
  makeWASocket,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "@whiskeysockets/baileys";
import {
  defineChannel,
  POST,
  type ChannelEvents,
  type ChannelFrom,
} from "eve/channels";
import QRCode from "qrcode";

import { readTextMessage } from "../lib/messages";
import { isWhatsAppEnabled } from "../lib/runtime-config";

interface WhatsAppState {
  jid: string;
  lastInboundKey?: WAMessageKey;
}

interface WhatsAppChannelContext {
  state: WhatsAppState;
  socket: WASocket | null;
}

interface QueuedMessage {
  jid: string;
  text: string;
  state: WhatsAppState;
}

interface WhatsAppRuntime {
  socket: WASocket | null;
  socketStarting: Promise<WASocket> | null;
  bootstrapStarting: Promise<void> | null;
  capturedFrom: ChannelFrom<WhatsAppState> | null;
  queue: QueuedMessage[];
  listenersAttached: boolean;
}

const GLOBAL_KEY = "__astra_whatsapp_channel__";
const DEFAULT_AUTH_DIR = "./auth_info_baileys";
const DEFAULT_PORT = "2000";

function runtime(): WhatsAppRuntime {
  const root = globalThis as Record<string, unknown>;
  const current = root[GLOBAL_KEY];

  if (isWhatsAppRuntime(current)) return current;

  const created: WhatsAppRuntime = {
    socket: null,
    socketStarting: null,
    bootstrapStarting: null,
    capturedFrom: null,
    queue: [],
    listenersAttached: false,
  };
  root[GLOBAL_KEY] = created;
  return created;
}

function isWhatsAppRuntime(value: unknown): value is WhatsAppRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (
    "socket" in value &&
    "socketStarting" in value &&
    "bootstrapStarting" in value &&
    "capturedFrom" in value &&
    "queue" in value &&
    "listenersAttached" in value
  );
}

function isDirectMessage(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && (isPnUser(jid) === true || isLidUser(jid) === true);
}

function disconnectStatus(error: unknown): number | undefined {
  return isBoom(error) ? error.output.statusCode : undefined;
}

async function renderQr(qr: string): Promise<void> {
  try {
    const rendered = await QRCode.toString(qr, { type: "terminal", small: true });
    console.info("\n[whatsapp] Scan this QR code in WhatsApp > Settings > Linked Devices:\n");
    console.info(rendered);
  } catch (error) {
    console.error("[whatsapp] could not render the QR code", error);
    console.info(`[whatsapp] raw QR data: ${qr}`);
  }
}

async function connectSocket(): Promise<WASocket> {
  const active = runtime();
  if (active.socket) return active.socket;
  if (active.socketStarting) return active.socketStarting;

  active.socketStarting = (async () => {
    const authDirectory = process.env.WHATSAPP_AUTH_DIR ?? DEFAULT_AUTH_DIR;
    const { state, saveCreds } = await useMultiFileAuthState(authDirectory);
    const { version } = await fetchLatestBaileysVersion();
    const socket = makeWASocket({
      version,
      auth: state,
      browser: Browsers.ubuntu("astra-whatsapp"),
    });
    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      if (update.qr) void renderQr(update.qr);

      if (update.connection === "open") {
        console.info("[whatsapp] connected");
        void bootstrapChannel();
        return;
      }

      if (update.connection !== "close" || runtime().socket !== socket) return;

      const status = disconnectStatus(update.lastDisconnect?.error);
      const reconnect =
        status !== DisconnectReason.loggedOut &&
        status !== DisconnectReason.connectionReplaced;

      console.error(`[whatsapp] connection closed status=${status ?? "unknown"}`);
      const current = runtime();
      current.socket = null;
      current.socketStarting = null;
      current.listenersAttached = false;

      if (reconnect) setTimeout(startSocket, 1_000);
    });

    active.socket = socket;
    return socket;
  })().catch((error: unknown) => {
    const current = runtime();
    current.socket = null;
    current.socketStarting = null;
    console.error("[whatsapp] socket startup failed", error);
    throw error;
  });

  return active.socketStarting;
}

async function bootstrapUntilReady(): Promise<void> {
  const port = process.env.PORT ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/whatsapp/bootstrap`;
  let delayMilliseconds = 500;

  while (!runtime().capturedFrom) {
    try {
      const response = await fetch(url, { method: "POST" });
      if (response.ok) return;
    } catch {
      // Eve may still be starting. Keep the queued messages until its route is ready.
    }

    await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds));
    delayMilliseconds = Math.min(delayMilliseconds * 2, 30_000);
  }
}

function bootstrapChannel(): Promise<void> {
  const active = runtime();
  if (!active.bootstrapStarting) {
    active.bootstrapStarting = bootstrapUntilReady().finally(() => {
      runtime().bootstrapStarting = null;
    });
  }
  return active.bootstrapStarting;
}

async function dispatchText(jid: string, text: string, key: WAMessageKey): Promise<void> {
  const state: WhatsAppState = { jid, lastInboundKey: key };
  const from = runtime().capturedFrom;

  if (from) {
    await from(jid).send(text, { auth: null, state });
    return;
  }

  runtime().queue.push({ jid, text, state });
  void bootstrapChannel();
}

async function handleInboundMessage(message: WAMessage): Promise<void> {
  const jid = message.key.remoteJid;
  if (!isDirectMessage(jid) || message.key.fromMe === true) return;

  const text = readTextMessage(message.message);
  if (!text) return;

  console.info(`[whatsapp] received text jid=${jid} length=${text.length}`);
  await dispatchText(jid, text, message.key);
}

function attachInboundListener(socket: WASocket): void {
  const active = runtime();
  if (active.listenersAttached) return;

  socket.ev.on(
    "messages.upsert",
    async ({ messages, type }: BaileysEventMap["messages.upsert"]) => {
      if (type !== "notify") return;

      for (const message of messages) {
        try {
          await handleInboundMessage(message);
        } catch (error) {
          console.error("[whatsapp] inbound message failed", error);
        }
      }
    },
  );

  active.listenersAttached = true;
}

function startSocket(): void {
  void connectSocket().then(attachInboundListener).catch(() => {
    // connectSocket logs the actionable error and resets the retry guards.
  });
}

async function sendText(socket: WASocket, jid: string, text: string): Promise<void> {
  const maximumLength = 65_536;
  for (let offset = 0; offset < text.length; offset += maximumLength) {
    await socket.sendMessage(jid, { text: text.slice(offset, offset + maximumLength) });
  }
}

async function markRead(socket: WASocket, key: WAMessageKey): Promise<void> {
  try {
    await socket.readMessages([key]);
  } catch {
    // A failed read receipt must not hide a completed browser task reply.
  }
}

export default defineChannel<WhatsAppState, WhatsAppChannelContext>({
  kindHint: "whatsapp",
  turnPolicy: "queue",
  state: { jid: "" },

  metadata(state) {
    return { jid: state.jid, audience: "private" as const };
  },

  context(state) {
    return { state, socket: runtime().socket };
  },

  routes: [
    POST("/whatsapp/bootstrap", async (_request, { from }) => {
      const active = runtime();
      active.capturedFrom = from;

      while (active.queue.length > 0) {
        const queued = active.queue.shift();
        if (!queued) break;

        try {
          await from(queued.jid).send(queued.text, { auth: null, state: queued.state });
        } catch (error) {
          console.error("[whatsapp] queued message dispatch failed", error);
        }
      }

      return new Response("ok");
    }),
  ],

  async receive(input, { from }) {
    const target = input.target;
    const jid =
      typeof target === "object" && target !== null && "threadId" in target
        ? String(target.threadId)
        : String(target);

    return from(jid).send(input.message, {
      auth: input.auth,
      state: { jid },
    });
  },

  events: {
    async "message.completed"(event, channel) {
      const { socket, state } = channel;
      if (!socket || !state.jid || !event.message || event.finishReason === "tool-calls") return;

      await sendText(socket, state.jid, event.message);
      if (state.lastInboundKey) await markRead(socket, state.lastInboundKey);
    },

    async "turn.failed"(event, channel) {
      const { socket, state } = channel;
      if (!socket || !state.jid) return;
      await sendText(socket, state.jid, event.message ?? "The browser task failed. Please try again.");
    },

    async "session.failed"(event, channel) {
      const { socket, state } = channel;
      if (!socket || !state.jid) return;
      const message = event.details?.message;
      await sendText(
        socket,
        state.jid,
        typeof message === "string" ? message : "The browser session could not continue.",
      );
    },
  } satisfies ChannelEvents<WhatsAppChannelContext>,
});

if (isWhatsAppEnabled(process.env.ASTRA_WHATSAPP_ENABLED)) {
  startSocket();
}
