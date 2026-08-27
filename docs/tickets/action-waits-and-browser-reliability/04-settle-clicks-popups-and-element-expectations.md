# 04 - Settle clicks, popups, and element expectations

## Goal

A click reports the navigation, popup, semantic page change, or stable layout that proves what happened after the element was activated.

## Files

Create:
- `chrome-extension/src/browser/waits/expectation.ts`
- `chrome-extension/src/browser/waits/layout.ts`
- `chrome-extension/tests/browser-click-waits.test.ts`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/actions/element.ts`
- `chrome-extension/src/browser/actions/new-tab.ts`
- `chrome-extension/src/browser/actions/dispatcher.ts`
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/tests/fixtures/browser-action-waits.html`

## Implementation notes

- Ticket 01 accepts and validates `wait.expectation` shape at the message boundary only. This ticket owns enforcing expectations: reading the parsed policy from `BrowserActionRequest.wait` and using it as completion evidence.

- Start popup, navigation, network, DOM, expectation, and layout watchers before `ElementHandle.click()`.
- Keep popup detection alive until the bounded action barrier ends. Match a new tab to the clicked tab through `openerTabId` and clean up the Chrome listener on every path.
- Support one exact role and accessible-name expectation for appearance or disappearance across live frames and open shadow roots. Use it only as completion evidence. Zero matches satisfies disappearance, one match satisfies appearance, and multiple matches satisfy neither.
- When no navigation, popup, or expectation occurs, complete after DOM quiet and two layout samples at least 100 milliseconds apart differ by no more than the configured tolerance.
- Do not replay the click after dispatch. Preserve the existing grounded target resolution and snapshot invalidation rules.

## Blocked by

- 03 - Measure navigation and frame commits

## Done when

- A click-created tab that appears after `ElementHandle.click()` resolves still returns its new tab ID and popup evidence.
- A click that performs a full navigation, a same-document route change, or a DOM-only update returns the matching measured signals.
- Exact appearance and disappearance expectations work in the main document and a child frame. An ambiguous appearance remains pending until timeout.
- A click with no page mutation completes from measured DOM and layout stability without a fixed sleep.
- `bun test chrome-extension/tests/browser-click-waits.test.ts chrome-extension/tests/browser-click-actions.test.ts` passes and reports no leaked popup, frame, or page listeners.
