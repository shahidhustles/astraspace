# 05 - Render provider reasoning

## Goal

When Eve supplies reasoning, the user can follow it while it streams without showing an empty or invented reasoning panel.

## Files

Create:
- `chrome-extension/src/components/ai-elements/reasoning.tsx`

Modify:
- `chrome-extension/src/components/chat-message.tsx`
- `chrome-extension/src/style.css`

## Implementation notes

- Narrow Eve message parts by `part.type` and pass only real reasoning text to `ReasoningContent`.
- Keep the reasoning section open while its part state is streaming, then collapse it when complete.
- Render no reasoning control when Eve emits no reasoning part.
- Preserve keyboard access, visible focus, reduced-motion behavior, and readable side-panel resizing from `DESIGN.md`.

## Blocked by

- 02 - Stream a real Eve reply.

## Done when

- A response that emits reasoning shows it incrementally and collapses the section after streaming finishes.
- A response without reasoning shows no empty reasoning control.
- `bun run build:extension` and `bun run check:agent` both pass after all five tickets are integrated.
