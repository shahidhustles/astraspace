# Astra WhatsApp channel

This workspace package mounts a text-only WhatsApp channel into Astra's existing Eve agent. It uses Baileys, an unofficial WhatsApp Web client.

## Choose how to run the agent

From the repository root:

```bash
bun run dev:agent
```

This starts the Astra Eve agent without opening a WhatsApp connection. Use it for the browser extension and other direct agent work.

To start the agent with WhatsApp enabled, run:

```bash
bun run dev:whatsapp
```

This sets `ASTRA_WHATSAPP_ENABLED=1` and starts the existing Astra Eve agent with the WhatsApp channel active. Both commands start the same Eve server, so stop one before running the other.

The WhatsApp extension stays mounted in both modes, but it does not create a Baileys socket, read credentials, show a QR code, or retry a connection unless `ASTRA_WHATSAPP_ENABLED` is exactly `1`.

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
