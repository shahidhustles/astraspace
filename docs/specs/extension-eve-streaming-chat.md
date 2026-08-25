# Extension to Eve streaming chat

## Goal

Build the first working Astra Space user interface as a Chrome side panel. A user can send a text prompt to the local Eve agent and read the assistant response as it streams. The interface uses the tokens in `DESIGN.md` and the requested AI Elements component families.

## User flow

1. The user loads the unpacked extension and clicks the Astra Space toolbar action.
2. Chrome opens the Astra Space side panel.
3. The panel shows an empty conversation, the configured model, context-window usage when measured, and a prompt composer.
4. The user submits a text prompt. The user message appears immediately and Eve begins a durable turn.
5. Assistant text streams into the conversation. Provider reasoning appears in its own section when Eve supplies it.
6. The user may submit another prompt while the response is streaming. Eve steers the active turn and starts the replacement turn.
7. The user may stop an active turn. The same conversation remains ready for another prompt.
8. Closing and reopening the panel starts a fresh local interface for v1.

## Requirements

- Use a React and TypeScript side-panel interface inside the existing Vite extension package.
- Apply the colors, typography, spacing, shape, focus, motion, and plain-language rules from `DESIGN.md`.
- Compose the chat from AI Elements `Conversation`, `Message`, `PromptInput`, `Context`, `ModelSelector`, and `Reasoning` families. Adapt their copied source to Astra Space tokens rather than retaining default styling.
- Render user messages immediately and assistant text incrementally as Eve streams it.
- Keep the composer available during streaming. A submission while busy must steer the active Eve turn.
- Provide a Stop control while a turn is submitted or streaming.
- Show the one configured Eve model in `ModelSelector`. Do not offer fake choices. Leave a code `TODO` at the model-option boundary for future multi-model routing.
- Use `Context` to show the latest measured model-call token usage as a percentage of the real context-window maximum.
- Show `Not measured` when either token usage or the context maximum is unavailable. Never substitute zero or estimated values.
- Render only reasoning parts received from Eve. Keep reasoning open while it streams and collapsed after it finishes. Hide the section when Eve sends no reasoning.
- Show clear ready, connecting, submitted, streaming, steering, stopped, and error states without shifting the composer layout.
- Support keyboard submission, visible focus, accessible names, reduced motion, and readable side-panel resizing.
- Keep the v1 local-only. It has no login, remote deployment, or production authentication flow.
- Keep conversation history in component memory only. Do not persist or restore sessions, messages, events, or cursors.

## Implementation decisions

- Convert `chrome-extension/` from vanilla TypeScript to React 19 with the Vite React plugin.
- Add Tailwind CSS 4 and the shadcn/ui setup required by the copied AI Elements source. Bundle every script, component, icon, font, and Markdown dependency with the extension to comply with MV3 restrictions.
- Keep AI Elements and shadcn source under the extension package. Do not place UI components in `packages/shared`.
- Use `useEveAgent()` from `eve/react` as the browser client and state layer. Do not use AI SDK `useChat()` or translate Eve events into the AI SDK UI stream protocol.
- The visible side-panel page connects directly to the local Eve host. The MV3 service worker opens the side panel and later owns browser APIs, but it does not proxy the chat stream.
- Update the MV3 manifest with a side-panel entry, a module service worker, the `sidePanel` permission, and a narrow development host permission for `http://127.0.0.1:2000/*`.
- Keep `localDev()` in the Eve channel as the local-demo access path. No authentication UI or anonymous production policy is part of this slice.
- For a ready session, call `agent.send(text)`. While `status` is `submitted` or `streaming`, call `agent.send(text, { turnPolicy: "steer" })`.
- Stop calls `agent.cancel()`. Closing the side panel is not treated as cancellation.
- Render narrowed Eve message parts directly through AI Elements. Text goes to `MessageResponse`; reasoning goes to the `Reasoning` family. Avoid casting complete Eve messages to AI SDK `UIMessage`.
- Derive the displayed model and latest completed-call usage from Eve events. Read the real context-window maximum from Eve agent information when available.
- Keep the current static model configuration in `packages/agent-core/agent/agent.ts`. Multi-model selection requires a later trusted backend allowlist and resolver.

## Demo / acceptance

- [ ] `bun run build:extension` completes without TypeScript or Vite errors.
- [ ] `bun run check:agent` reports zero Eve compile diagnostics.
- [ ] Loading `chrome-extension/dist` as an unpacked extension and clicking its toolbar action opens the side panel.
- [ ] With the local Eve server running, submitting a prompt shows the user message and streams a real assistant response into `Conversation`.
- [ ] `Message`, `PromptInput`, and streaming status behavior remain usable at normal side-panel widths and by keyboard.
- [ ] Submitting a second prompt during streaming steers the active turn and the replacement response continues in the same visible conversation.
- [ ] Stop requests Eve cancellation and returns the composer to a usable state after the cancellation settles.
- [ ] `ModelSelector` shows only the configured model.
- [ ] `Context` shows a real latest-call percentage when both values exist, otherwise it says `Not measured`.
- [ ] Provider reasoning streams through `Reasoning`, collapses when finished, and remains absent when Eve emits none.
- [ ] Stopping Eve or making the local endpoint unavailable produces a clear recoverable error in the panel.
- [ ] The interface uses `DESIGN.md` tokens and does not display fabricated model, usage, reasoning, or connection data.

## Out of scope

- Browser observation, page capture, content scripts, DOM inspection, redaction, privacy inspection, and browser actions.
- Conversation persistence, session restoration, reconnect after panel closure, and history across browser restarts.
- Multiple models, model switching, dynamic model routing, and model settings.
- Authentication, user accounts, production bearer tokens, session ownership, hosted deployment, and production CORS policy.
- Attachments, screenshots, voice input, tools, approvals, artifacts, subagents, Telegram, WhatsApp, and MCP integrations.
- Automated end-to-end browser tests beyond the listed build checks and manual demo.
