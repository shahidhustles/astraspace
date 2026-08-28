# 04 - Show browser tools with AI Elements

## Goal

The side panel shows each Eve browser tool in message order with a concise live status, useful evidence, and recovery text using the official AI Elements Tool component family.

## Files

Create:
- `chrome-extension/src/components/ai-elements/tool.tsx`
- `chrome-extension/src/components/browser-tool-part.tsx`
- `chrome-extension/src/lib/browser-tool-presentation.ts`
- `chrome-extension/tests/browser-tool-presentation.test.ts`

Modify:
- `bun.lock`
- `chrome-extension/package.json`
- `chrome-extension/src/components/chat-message.tsx`
- `chrome-extension/tests/chat-message.test.tsx`
- `chrome-extension/src/style.css`

## Implementation notes

- Run `bunx ai-elements@latest add tool` from `chrome-extension`, then adapt the installed official source to Astra's existing tokens. Compose `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, and `ToolOutput`; do not build parallel custom disclosure or status components.
- Render Eve's real `dynamic-tool` parts directly in their existing message-part order. Adapt `part.toolName` to the Tool header type and pass its AI SDK-compatible lifecycle state rather than inventing a second tool state machine.
- Present the product labels `requested`, `running`, `completed`, `timed out`, `cancelled`, and `failed`. Derive terminal timeout and cancellation labels from the typed browser result, not from elapsed time or guessed copy.
- Keep inputs inspectable but concise. For outputs, render a purpose-built summary of action, tab or URL, completion evidence, and recovery guidance through `ToolOutput`. Never pass the raw observation object to the component because it contains the semantic DOM and JPEG base64.
- Use `errorText` for Eve `output-error` parts and concise typed recovery text for stale refs, uncertain replay, unavailable browser, cancellation, and post-action observation failure. Keep successful observations collapsed by default.
- Preserve assistant text, reasoning, message order, streaming animation, model and context controls, steering, stop, and the existing recoverable Eve error state. Keep accessible status text and keyboard-operable disclosure behavior from AI Elements.

## Blocked by

- 03 - Run the grounded action catalog safely

## Done when

- A real Eve tool call appears in the side panel using AI Elements `ToolHeader`, `ToolContent`, `ToolInput`, and `ToolOutput`, then advances from requested or running to its truthful terminal label.
- Completed rows show bounded action evidence; timed-out, cancelled, stale, uncertain, unavailable, and failed rows show a concise next step.
- No rendered chat markup contains screenshot base64 or the full semantic DOM, including when an observation or post-action observation fails.
- Text, reasoning, and dynamic-tool parts remain in the exact order Eve emitted them, and Stop still cancels the active turn.
- `bun test chrome-extension/tests/chat-message.test.tsx chrome-extension/tests/browser-tool-presentation.test.ts`, `bunx tsc -p chrome-extension/tsconfig.json --noEmit`, `bun run build:extension`, and `git diff --check` pass.
