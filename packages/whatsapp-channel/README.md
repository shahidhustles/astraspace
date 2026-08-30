# Astra WhatsApp channel

This workspace package mounts a text-only WhatsApp channel into Astra's existing Eve agent. It uses Baileys, an unofficial WhatsApp Web client.

## Run it

From the repository root:

```bash
bun run dev:whatsapp
```

This starts the existing Astra Eve agent with the WhatsApp channel mounted. It is the same runtime as `bun run dev:agent`, so do not start both commands at once.

On the first run, scan the terminal QR code in WhatsApp under **Settings > Linked Devices > Link a Device**. The `dev:whatsapp` command starts Eve directly from `packages/agent-core` with `--no-ui --logs all`. Bun does not collapse the QR rows behind `[lines elided]`, and Eve does not cover them with its terminal dashboard.

Baileys saves the linked-device credentials in `packages/agent-core/auth_info_baileys/`. Later starts reuse the linked session and do not show another QR.

Then send a direct text message to the linked WhatsApp account from a different account. Astra receives that text as the user prompt, uses its existing `browser-mcp` connection, and sends the final assistant response back to the same WhatsApp chat.

The channel ignores groups, messages sent by the linked account, images, video, audio, stickers, documents, and other non-text messages. It does not send reasoning, tool calls, or pre-tool assistant text.

You can override two local settings:

```bash
WHATSAPP_AUTH_DIR=/absolute/path/to/auth PORT=2000 bun run dev:whatsapp
```

`PORT` must match the Eve server port because the push-based Baileys socket uses a local bootstrap route to enter Eve's channel runtime.

## Caveat

Baileys is not affiliated with WhatsApp or Meta. WhatsApp can change its private protocol or restrict linked accounts. This package is suitable for the local single-user demo described here, not a production WhatsApp integration.
