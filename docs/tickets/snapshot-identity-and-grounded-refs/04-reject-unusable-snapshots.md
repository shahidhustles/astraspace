# 04 - Reject unusable snapshots

## Goal

Target lookup rejects evicted, invalidated, epoch-mismatched, and incomplete snapshot targets without falling back to another ref map.

## Files

Create:
- None.

Modify:
- `chrome-extension/src/browser/snapshot.ts`
- `chrome-extension/src/browser/types.ts`
- `chrome-extension/tests/browser-snapshot.test.ts`

## Implementation notes

- Retain the current snapshot and seven earlier successful snapshots per tab.
- Model expected failures as discriminated results. Use `stale_ref` for an unavailable snapshot and `target_not_found` when a valid snapshot does not own the requested ref.
- Invalidation must disable the entire executable cache. Diagnostic state, if retained, must live outside target lookup.
- Compare both document and navigation epochs before returning a record.

## Blocked by

- 03 - Commit exact snapshots

## Done when

- Looking up the ninth older snapshot returns `stale_ref`, while the eight retained snapshots remain available.
- Unknown, invalidated, and epoch-mismatched snapshots return `stale_ref`; an absent ref in a valid snapshot returns `target_not_found`.
