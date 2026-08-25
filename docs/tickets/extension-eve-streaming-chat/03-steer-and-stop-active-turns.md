# 03 - Steer and stop active turns

## Goal

The user can replace a response with a new instruction or stop it without breaking the conversation.

## Files

Modify:
- `chrome-extension/src/components/chat-panel.tsx`
- `chrome-extension/src/components/ai-elements/prompt-input.tsx`
- `chrome-extension/src/style.css`

## Implementation notes

- Keep the composer enabled while Eve is `submitted` or `streaming`.
- Send ordinary turns with `agent.send(text)`. While busy, send with `agent.send(text, { turnPolicy: "steer" })`.
- Expose a Stop action only while busy and call `agent.cancel()`.
- Distinguish submitted, streaming, steering, stopped, and error states with stable layout and direct copy.

## Blocked by

- 02 - Stream a real Eve reply.

## Done when

- Submitting a second prompt during streaming replaces the active Eve turn and the replacement response continues in the visible conversation.
- Stop requests durable cancellation, settles without cancelling a later turn, and leaves the composer ready for another prompt.

