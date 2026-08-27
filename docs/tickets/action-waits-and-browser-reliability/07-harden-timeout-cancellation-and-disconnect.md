# 07 - Harden timeout, cancellation, and disconnect

## Goal

Every action exits with truthful evidence and clean state when settling times out, the caller cancels, or Chrome removes the controlled page.

## Files

Create:
- `chrome-extension/tests/browser-action-lifecycle.test.ts`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/actions/types.ts`
- `chrome-extension/src/browser/actions/dispatcher.ts`
- `chrome-extension/src/browser/runtime.ts`
- `chrome-extension/src/browser/context.ts`
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/types.ts`

## Implementation notes

- Return `ok: true` with `completion.status: "timed_out"` when dispatch succeeded but settling did not. Return `action_wait_timeout` only when the queue deadline expires before dispatch.
- Active cancellation returns `action_cancelled` and records whether dispatch started. A dispatched mutating action stays invalidated even when cancellation interrupts its wait.
- Abort every active and queued action when its tab closes, the debugger detaches, the connection generation changes, or cleanup runs. Preserve the existing lifecycle error that caused the abort.
- Retry no mutating action after dispatch. Keep Spec 4's single detached-target retry before dispatch, and allow one read-only evidence probe retry inside the original deadline.
- Bound signal arrays and page-derived strings before crossing the runtime boundary. Remove every listener, observer, handle, timer, queue entry, and action ID in `finally`.

## Blocked by

- 06 - Report tab lifecycle completion

## Done when

- Timeout and cancellation before dispatch do not mutate the page. The same events after dispatch report uncertain page state and keep prior refs stale.
- Tab removal, debugger detach, connection replacement, and runtime cleanup end active waits with their lifecycle cause and allow no queued action to run afterward.
- A timed-out click, type, keypress, select, navigation, or tab mutation is never dispatched a second time.
- Every success and failure variant is JSON-safe, has bounded completion evidence, and leaves coordinator registries empty.
- `bun test chrome-extension/tests/browser-action-lifecycle.test.ts chrome-extension/tests/browser-action-runtime.test.ts chrome-extension/tests/browser-context.test.ts` passes.
