# 05 - Wait for scroll stability

## Goal

Document, container, and text scrolling return only after the requested position has been reached and remains stable.

## Files

Create:
- `chrome-extension/src/browser/waits/scroll.ts`
- `chrome-extension/tests/browser-scroll-waits.test.ts`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/waits/layout.ts`
- `chrome-extension/src/browser/actions/scroll.ts`
- `chrome-extension/src/browser/actions/dispatcher.ts`
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/tests/fixtures/browser-action-waits.html`

## Implementation notes

- Capture a bounded position probe for the document or resolved scroll container before invalidating its snapshot. Do not re-resolve an invalidated grounded target during the wait.
- Require the requested position and two stable samples before completion. Include final coordinates and the scroll-stable signal in result evidence.
- Retain any resolved handle only for the bounded barrier and dispose it in `finally`, including timeout, cancellation, detach, and target-removal paths.
- Keep DOM quiet in the policy when scrolling triggers lazy rendering. Do not add a fixed post-scroll delay.

## Blocked by

- 04 - Settle clicks, popups, and element expectations

## Done when

- Page, percentage, edge, grounded-container, and visible-text scrolling report their reached and stable positions.
- Lazy content inserted during a scroll extends the DOM quiet window before completion.
- A removed container, timeout, or cancellation returns bounded evidence and disposes the retained handle without making the source snapshot executable.
- `bun test chrome-extension/tests/browser-scroll-waits.test.ts chrome-extension/tests/browser-scroll-actions.test.ts` passes without fixed action sleeps.
