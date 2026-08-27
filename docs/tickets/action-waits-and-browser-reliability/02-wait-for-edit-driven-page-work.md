# 02 - Wait for edit-driven page work

## Goal

Typing, clearing, keypress, and native selection return only after their tracked requests and DOM updates become quiet.

## Files

Create:
- `chrome-extension/src/browser/waits/network.ts`
- `chrome-extension/src/browser/waits/dom.ts`
- `chrome-extension/tests/browser-action-settling.test.ts`
- `chrome-extension/tests/fixtures/browser-action-waits.html`

Modify:
- `chrome-extension/src/browser/waits/coordinator.ts`
- `chrome-extension/src/browser/waits/types.ts`
- `chrome-extension/src/browser/actions/input.ts`
- `chrome-extension/src/browser/actions/keyboard.ts`
- `chrome-extension/src/browser/actions/select.ts`
- `chrome-extension/src/browser/actions/dispatcher.ts`
- `chrome-extension/src/browser/actions/types.ts`
- `chrome-extension/src/browser/page.ts`

## Implementation notes

- Install request listeners and frame DOM observers before the helper invalidates the snapshot or changes the page.
- Track `document`, `xhr`, `fetch`, `script`, and `stylesheet` requests, including child-frame document requests. Do not invent an `iframe` Puppeteer resource type. Remove work on both `requestfinished` and `requestfailed`. Count WebSocket, EventSource, media, and other excluded long-lived requests without letting them block quiet.
- Measure 300 milliseconds of DOM quiet and 500 milliseconds of relevant network quiet after the last activity. Put timings behind injectable constants so unit tests do not sleep for production durations.
- Observe every currently live frame Astra can access. Clean up all observers and Puppeteer listeners in `finally`.
- Add JSON-safe signal records and request counts to the result completion union. Preserve the existing action-specific result data and error codes.

## Blocked by

- 01 - Own one action per tab

## Done when

- An edit that starts a delayed `fetch` and then renders suggestions returns after the response and DOM update become quiet.
- A failed `fetch` leaves no pending request, while a permanent WebSocket appears only in ignored-request evidence and does not force a timeout.
- Type, clear, keypress, and select results report measured network and DOM signals. Their source snapshots remain invalid after dispatch.
- `bun test chrome-extension/tests/browser-action-settling.test.ts chrome-extension/tests/browser-input-actions.test.ts chrome-extension/tests/browser-keyboard-actions.test.ts chrome-extension/tests/browser-select-actions.test.ts` passes without leaked listeners or observers.
