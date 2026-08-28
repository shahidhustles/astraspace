# 05 - Prove the complete Eve browser loop

## Goal

A real Eve session can observe and change a deterministic page through the built MV3 worker, recover from lifecycle failures, and finish with browser evidence visible in the side panel.

## Files

Create:
- `chrome-extension/tests/fixtures/eve-browser-control.html`
- `chrome-extension/tests/eve-browser-control-loop.integration.test.ts`
- `packages/agent-core/tests/eve-browser-control-loop.test.ts`

Modify:
- `chrome-extension/tests/helpers/mv3-driver.ts`
- `chrome-extension/tests/helpers/mv3-worker-harness.ts`
- `chrome-extension/package.json`
- `packages/agent-core/package.json`
- `package.json`

## Implementation notes

- Drive the authored Eve tool, broker routes, built background service worker, and `chrome.runtime.sendMessage` boundary. A direct tool helper, fake broker result, constructed `BrowserContext`, or source-only background import does not prove this loop.
- Give every launched Chrome instance a unique temporary `userDataDir`. Close its browser in `finally`, then remove only that verified profile. Do not use broad Chrome process cleanup.
- Use a deterministic local fixture with semantic content, rerendered refs, multiple fields, native select, delayed completion, and visible success evidence. Reuse measured waits; add no fixed post-action sleep.
- Prove session resume, reconnect with the same request ID, queued and dispatched cancellation, worker restart, debugger detach, tab close, stale refs, post-dispatch timeout, and bridge interruption. Check that mutations never replay and every pending request settles.
- Keep model-dependent summarize and form runs as human acceptance checks with the configured provider. Automated acceptance must remain deterministic and fail when Chrome or `PUPPETEER_EXECUTABLE_PATH` is unavailable rather than silently skip.

## Blocked by

- 04 - Show browser tools with AI Elements

## Done when

- A built-extension test sends a browser request through an authored Eve tool, observes the fixture, changes it through the worker, re-observes it, and asserts the final visible page evidence and dynamic-tool transcript.
- Reopening the panel resumes the same running or completed Eve session without page payloads in extension storage.
- A stale ref is not reused; a post-dispatch timeout, cancellation, restart, detach, tab close, or interrupted result returns bounded truthful state and never repeats the mutation.
- After failure recovery, the same Eve session accepts another prompt and the worker, broker directory, timers, listeners, action queues, and temporary Chrome profile are clean.
- A human run can summarize an open Wikipedia article and complete the local multi-field form with visible observe and action rows grounded in the final page.
- `bun test`, the focused real-Chrome integration command, TypeScript checks for every changed package, `bun run build:extension`, `bun run check:agent`, a built-bundle Node-import scan, and `git diff --check` pass.
