# 08 - Prove waits through the real MV3 worker

## Goal

The shipped extension service worker proves measured action completion against real Chrome rather than only constructed runtime objects.

## Files

Create:
- `chrome-extension/tests/browser-action-waits.integration.test.ts`

Modify:
- `chrome-extension/tests/browser-mv3-runtime.integration.test.ts`
- `chrome-extension/tests/fixtures/browser-action-waits.html`
- `chrome-extension/package.json`

## Implementation notes

- Exercise the built background service worker through `chrome.runtime.sendMessage`. Do not bypass it with a direct helper or `BrowserContext` call.
- Use local fixture routes for immediate navigation, same-document routing, delayed and failed fetches, a permanent WebSocket, DOM-only updates, nested frame navigation, popup creation, lazy scroll content, and an unsupported redirect.
- Assert watcher-before-dispatch evidence, final URLs, request counts, quiet durations, snapshot invalidation, cancellation, timeout, and cleanup. Do not use a fixed delay as action completion evidence.
- Detach-mid-action needs more than the unit-level dead-transport simulation from 07 (`detachIfDisconnected` driven by a fake `browser.connected` flip): kill a real debugger session through Chrome while a fixture action is mid-barrier and prove the wait ends with its lifecycle cause, refs stay stale, and nothing replays.
- Require Chrome or `PUPPETEER_EXECUTABLE_PATH`. A skipped browser test does not pass this ticket.
- Keep test-only host permissions and smoke scripts in the temporary copied extension. Do not expand the shipped manifest.

## Blocked by

- 07 - Harden timeout, cancellation, and disconnect

## Done when

- A real unpacked MV3 build completes the navigation, SPA, popup, fetch autocomplete, frame navigation, semantic expectation, and scroll fixtures with the expected completion signals.
- Timeout, cancellation, failed request, unsupported redirect, permanent WebSocket, tab removal, and debugger detach cases return truthful evidence without replay or leaked listeners.
- `bun test chrome-extension/tests`, `bun run --cwd chrome-extension test:integration`, `bunx tsc -p chrome-extension/tsconfig.json --noEmit`, and `bun run build:extension` pass.
- `git diff --check` passes, and the built background bundle contains no Node-only imports or fixed one-second action sleep.
