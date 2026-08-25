# 04 - Show real model and context usage

## Goal

The side panel identifies the configured model and shows how much of its context window the latest completed model call used.

## Files

Create:
- `chrome-extension/src/components/runtime-controls.tsx`
- `chrome-extension/src/components/ai-elements/context.tsx`
- `chrome-extension/src/components/ai-elements/model-selector.tsx`
- `chrome-extension/src/lib/eve-runtime-metadata.ts`

Modify:
- `chrome-extension/src/components/chat-panel.tsx`
- `chrome-extension/src/style.css`

## Implementation notes

- Derive the concrete model and latest completed-call token usage from Eve events. Read the real context-window maximum from Eve agent information when available.
- Render the percentage only when both used tokens and the maximum are real. Otherwise show `Not measured`.
- Show one configured model in `ModelSelector`. Do not add placeholder models. Leave a code `TODO` where a future trusted model allowlist will enter.
- Treat AI Elements `Context` as token-window telemetry, not sanitized browser page context.

## Blocked by

- 02 - Stream a real Eve reply.

## Done when

- `ModelSelector` displays only the model reported by Eve.
- After a completed response with usage metadata, `Context` displays the real context-window percentage. Missing metadata displays `Not measured` without a fabricated zero.

