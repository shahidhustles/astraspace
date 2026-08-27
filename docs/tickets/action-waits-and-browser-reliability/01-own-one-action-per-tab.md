# 01 - Own one action per tab

## Goal

The browser runtime can identify, serialize, and cancel action work without allowing two actions to race on the same tab.

## Files

Create:
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/tests/browser-action-coordinator.test.ts`

Modify:
- `chrome-extension/src/browser/actions/types.ts`
- `chrome-extension/src/browser/actions/validation.ts`
- `chrome-extension/src/browser/runtime.ts`
- `chrome-extension/src/browser/context.ts`
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/tests/browser-action-runtime.test.ts`

## Implementation notes

- Use `/typescript-best-practices`. Brand validated action IDs and model completion evidence as discriminated unions. Keep runtime messages `unknown` until one boundary parser validates them.
- Accept an optional top-level `actionId` and wait input without changing action-specific input objects. Generate an ID when omitted and reject a duplicate live ID.
- Add an individual action-cancellation runtime message. A caller-supplied ID lets that second message find a pending action while the original runtime call is unresolved.
- Keep one FIFO action queue per attached tab. Separate tabs must not share a queue or abort controller. The queue deadline starts when the runtime accepts the request, not when dispatch begins.
- Build the coordinator API needed by later wait policies, but do not report mutating actions as settled until a later ticket installs their measured completion rule.
- Remove completed and cancelled IDs from every registry in `finally`.

## Blocked by

None.

## Done when

- Two delayed actions for one tab dispatch in submission order, while delayed actions for separate tabs can overlap.
- Cancelling a queued action returns `action_cancelled` with `dispatchStarted: false` and never calls its dispatch function.
- Duplicate live IDs and malformed timeout or expectation input return `invalid_action` through `handleBrowserRuntimeMessage`.
- `bun test chrome-extension/tests/browser-action-coordinator.test.ts chrome-extension/tests/browser-action-runtime.test.ts` passes.
