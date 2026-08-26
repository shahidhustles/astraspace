# 06 - Verify live grounded targets

## Goal

A grounded target resolves only when the live page still contains the element recorded by its snapshot.

## Files

Create:
- `chrome-extension/src/browser/target-resolution.ts`
- `chrome-extension/tests/browser-target-resolution.test.ts`

Modify:
- `chrome-extension/src/browser/page.ts`
- `chrome-extension/src/browser/types.ts`

## Implementation notes

- Look up snapshot metadata before touching the DOM. Never reinterpret the number through the latest observation.
- Resolve the recorded DOM path in the main document, then verify tag, role, accessible name, and stable attributes.
- Bounds may support verification but cannot identify an element alone.
- Return a discriminated success or `stale_ref`, `target_not_found`, or `ambiguous_ref`. Expected target failures must not throw.
- Keep candidate verification separate from locator lookup so Spec 4 can add frame-aware locator methods without changing the result contract.

## Blocked by

- 05 - Publish versioned page observations

## Done when

- A target from an older retained snapshot resolves its original unchanged element, even when a newer snapshot reused the same ref number.
- Replacing the element at the recorded DOM path returns `target_not_found`, and more than one verified candidate returns `ambiguous_ref` with no element.
