# 02 - Observe the selected page through Eve

## Goal

Eve can call `browser_observe` and receive one synchronized semantic browser state and JPEG from the selected real tab through the local broker and built service worker.

## Files

Create:
- `packages/agent-core/agent/lib/browser-control.ts`
- `packages/agent-core/agent/tools/browser_observe.ts`
- `packages/agent-core/tests/browser-control.test.ts`
- `chrome-extension/tests/browser-eve-observe.integration.test.ts`

Modify:
- `packages/browser-control-contract/src/index.ts`
- `packages/agent-core/package.json`
- `chrome-extension/src/background.ts`
- `chrome-extension/src/browser/bridge.ts`
- `chrome-extension/src/browser/runtime.ts`
- `chrome-extension/src/browser/types.ts`
- `chrome-extension/package.json`

## Implementation notes

- Build `browser_observe` on one shared Eve bridge helper. Use `ctx.session.id`, `ctx.session.turn.id`, `ctx.callId`, and `ctx.abortSignal`; the model supplies none of those identifiers.
- Route the leased observation request into the existing `handleBrowserRuntimeMessage()` and service-worker-owned `BrowserContext`. Do not construct a second browser runtime or execute browser work in the side panel.
- Convert a successful observation with `toolOutput.content()`: emit the tabs, URL, title, scroll state, snapshot identity, grounded refs, and pruned semantic DOM through `toolOutputPart.text()`, then emit the matching raw JPEG through `toolOutputPart.file()` with `image/jpeg`.
- Never place screenshot base64 in the text part. Reject an image that does not match the observation's snapshot identity, and keep the complete tool output below Eve's 3 MiB warning threshold.
- Keep the broker's bounded wait for an initial worker bind. Return stable `browser_unavailable`, lease, protocol, lifecycle, and observation errors instead of waiting indefinitely.
- The integration test must load the built extension and invoke the authored Eve tool path. Direct calls to `BrowserContext.observe()` or a test-only tool executor do not satisfy this ticket.

## Blocked by

- 01 - Bind an Eve session to the extension

## Done when

- Asking Eve to inspect a deterministic local page produces a real `browser_observe` request and a model input containing the page's semantic text plus the matching JPEG.
- The response preserves `{ tabId, snapshotId, ref }` targets and the screenshot's snapshot identity without exposing private frame, backend-node, selector, or CDP fields.
- A missing worker, detached debugger, unsupported tab, expired lease, oversized result, or cancelled turn settles with a typed bounded failure.
- `bun run check:agent` reports Eve 0.44.4, zero diagnostics, and `browser_observe` as the only new tool at this point.
- `bun test packages/agent-core/tests/browser-control.test.ts chrome-extension/tests/browser-eve-observe.integration.test.ts`, TypeScript checks, `bun run build:extension`, and `git diff --check` pass.
