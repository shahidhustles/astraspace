# 06 - Report tab lifecycle completion

## Goal

Open, switch, close, and read-only select inspection return the same completion-evidence contract as page actions.

## Files

Create:
- `chrome-extension/tests/browser-tab-waits.test.ts`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/actions/dispatcher.ts`
- `chrome-extension/src/browser/actions/types.ts`
- `chrome-extension/src/browser/context.ts`
- `chrome-extension/src/browser/runtime.ts`
- `chrome-extension/tests/browser-tab-actions.test.ts`

## Implementation notes

- Install Chrome tab listeners before calling `tabs.create`, `tabs.update`, or `tabs.remove`.
- Opening completes after Chrome exposes a controllable URL and the extension attaches. Switching completes after activation and attachment. Closing completes only after Chrome confirms removal, then local connection state may be discarded.
- Keep existing URL policy, selected-tab ownership, and failure behavior. A failed close must retain local state.
- Return immediate `completed` evidence for `browser_get_select_options`. It remains read-only and keeps its source snapshot executable.
- Remove every Chrome listener and timeout after success or failure.

## Blocked by

- 05 - Wait for scroll stability

## Done when

- Open, switch, and close results contain action IDs, elapsed time, their Chrome lifecycle signal, selected tab state, and the correct snapshot-invalidated state.
- A failed or timed-out close leaves the page connected and selectable. A confirmed removal clears it once.
- Select inspection returns immediate completion evidence and the same grounded target can inspect again.
- `bun test chrome-extension/tests/browser-tab-waits.test.ts chrome-extension/tests/browser-tab-actions.test.ts chrome-extension/tests/browser-select-actions.test.ts` passes with no leftover Chrome listeners or timers.
