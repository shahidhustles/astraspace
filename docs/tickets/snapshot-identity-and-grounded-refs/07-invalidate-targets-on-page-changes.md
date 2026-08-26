# 07 - Invalidate targets on page changes

## Goal

Browser navigation and connection lifecycle changes make earlier grounded targets stale before an action can use them.

## Files

Create:
- None.

Modify:
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/context.ts`
- `chrome-extension/tests/browser-page.test.ts`
- `chrome-extension/tests/browser-context.test.ts`
- `chrome-extension/tests/browser-target-resolution.test.ts`

## Implementation notes

- Invalidate before Astra dispatches navigate, back, or refresh. CDP events also invalidate on external full-document and same-document navigation.
- Disconnect, unsupported-page transition, tab close, tab removal, and debugger detach must discard executable snapshot state.
- Do not invalidate another attached tab. Switching tabs preserves each tab's independent cache.
- A DOM rerender without a navigation event keeps the snapshot eligible for live verification.

## Blocked by

- 06 - Verify live grounded targets

## Done when

- Navigate, back, refresh, History API navigation, and hash navigation make an earlier target return `stale_ref` before resolution.
- Closing or detaching one tab removes only that tab's target state, while switching between live tabs preserves both caches.
