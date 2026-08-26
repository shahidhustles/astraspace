# 03 - Commit exact snapshots

## Goal

A tab can commit multiple observations with unique identities and retrieve a ref from the exact snapshot that created it.

## Files

Create:
- `chrome-extension/src/browser/snapshot.ts`
- `chrome-extension/tests/browser-snapshot.test.ts`

Modify:
- `chrome-extension/src/browser/types.ts`

## Implementation notes

- Add branded `SnapshotId`, snapshot identity fields, and the `{ tabId, snapshotId, ref }` grounded target type.
- Inject UUID creation into the snapshot store so tests remain deterministic.
- Start `snapshotVersion` at 1 per attached page and increment only when a snapshot commits.
- Copy or freeze committed metadata. Never retain a mutable rendering result or an `ElementHandle`.
- Reject a commit when refs are duplicated or public refs disagree with private grounding records.

## Blocked by

- 01 - Preserve grounding metadata
- 02 - Track main-frame epochs

## Done when

- Two snapshots may both contain ref `[1]`, yet each grounded target returns only its own recorded element metadata.
- Snapshot IDs differ, versions increase in commit order, and malformed ref maps never commit.
