# 02 - Stream a real Eve reply

## Goal

A user can submit text in the side panel and watch a real Eve response appear incrementally in the conversation.

## Files

Create:
- `chrome-extension/src/components/chat-panel.tsx`
- `chrome-extension/src/components/chat-message.tsx`
- `chrome-extension/src/components/ai-elements/conversation.tsx`
- `chrome-extension/src/components/ai-elements/message.tsx`
- `chrome-extension/src/components/ai-elements/prompt-input.tsx`
- `chrome-extension/src/components/ui/`
- `chrome-extension/src/lib/eve-config.ts`
- `chrome-extension/src/lib/utils.ts`

Modify:
- `chrome-extension/package.json`
- `chrome-extension/public/manifest.json`
- `chrome-extension/src/App.tsx`
- `chrome-extension/src/style.css`

## Implementation notes

- Install the AI Elements component source and its shadcn dependencies into the extension. Adapt the copied classes to `DESIGN.md` rather than recreating the components.
- Add `eve` at the same 0.44.4 line used by `packages/agent-core` and use `useEveAgent()` from `eve/react`.
- Connect the visible side-panel page directly to `http://127.0.0.1:2000`. Add only that origin to development `host_permissions`. The service worker must not relay the stream.
- Render narrowed Eve text parts through `MessageResponse`. Do not cast complete Eve messages to AI SDK `UIMessage` and do not use `useChat()`.
- Keep all session state in React memory. Show a recoverable connection error when Eve is unavailable.

## Blocked by

- 01 - Open a loadable React side panel.

## Done when

- With `bun run dev:agent` running, a submitted prompt appears immediately and a real assistant response streams into the same `Conversation`.
- With Eve stopped, submission produces a clear error and the composer remains usable for retry.

