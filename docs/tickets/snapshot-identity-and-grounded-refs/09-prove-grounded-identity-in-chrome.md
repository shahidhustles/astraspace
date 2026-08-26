# 09 - Prove grounded identity in Chrome

## Goal

The extension runtime returns versioned observations from a real Chrome tab and preserves grounded identity across consecutive captures.

## Files

Create:
- None.

Modify:
- `chrome-extension/tests/browser-observation.integration.test.ts`
- `chrome-extension/tests/browser-runtime.test.ts`

## Implementation notes

- Extend the existing Chrome integration fixture instead of adding another browser setup.
- Observe the same live tab twice and prove that snapshot IDs differ, versions increase, and the DOM, refs, and screenshot remain synchronized.
- Keep provider calls and the Eve loop outside this ticket.

## Blocked by

- 08 - Publish selected-tab state atomically

## Done when

- The runtime observation message returns all four identity fields unchanged.
- The real Chrome observation test proves that consecutive snapshots can reuse numeric refs without sharing snapshot identity.
- Browser tests pass and `bun run build:extension` succeeds.
