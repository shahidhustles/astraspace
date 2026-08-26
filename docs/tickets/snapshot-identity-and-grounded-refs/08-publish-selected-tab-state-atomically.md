# 08 - Publish selected-tab state atomically

## Goal

The selected-tab observation and its executable ref map commit together only after page capture and tab-list assembly both succeed.

## Files

Create:
- None.

Modify:
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/context.ts`
- `chrome-extension/src/browser/types.ts`
- `chrome-extension/tests/browser-context-observation.test.ts`
- `chrome-extension/tests/browser-page-observation.test.ts`

## Implementation notes

- Expose a staged page observation that `BrowserContext.observe()` can commit after tab listing succeeds.
- Serialize the complete selected-tab transaction, not only page capture, so overlapping requests commit in request order.
- If final assembly fails, publish no browser state and invalidate all prior executable snapshots for that tab.
- Keep the internal ref map out of the serialized `BrowserState`.

## Blocked by

- 07 - Invalidate targets on page changes

## Done when

- A tab-list failure after a successful page capture returns no state, commits no version, and makes prior targets stale.
- Overlapping observation requests return complete browser states in request order without mixing DOM, refs, screenshots, tabs, or snapshot identity.
- A successful `BrowserState` survives a JSON round trip without exposing its private ref map.
