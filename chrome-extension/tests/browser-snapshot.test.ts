import { describe, expect, test } from "bun:test";
import {
  SnapshotStore,
  type CommittedSnapshot,
  type CommitInput,
  type CommitResult,
} from "../src/browser/snapshot";
import type { FrameIdentity } from "../src/browser/document-identity";
import type { GroundingRecord, ObservedRef } from "../src/browser/observation/types";
import type { GroundedTarget, TargetLookupResult } from "../src/browser/types";

function sequencedUuids(): () => string {
  let next = 0;
  return () => `snap-${(next += 1)}`;
}

function observed(ref: number, tag: string, overrides: Partial<ObservedRef> = {}): ObservedRef {
  return { ref, tag, role: null, name: null, attrs: {}, bounds: null, ...overrides };
}

function grounding(
  ref: number,
  domPath: number[],
  tag: string,
  overrides: Partial<GroundingRecord> = {},
): GroundingRecord {
  return { ref, domPath, tag, role: null, name: null, attrs: {}, disabled: false, bounds: null, ...overrides };
}

function commit(
  store: SnapshotStore,
  tabId: number,
  refs: ObservedRef[],
  groundings: GroundingRecord[],
  overrides: Partial<CommitInput> = {},
): CommitResult {
  return store.commit({ tabId, documentEpoch: 0, navigationEpoch: 0, dom: "<document>", refs, groundings, ...overrides });
}

function expectCommitted(result: CommitResult): CommittedSnapshot {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  return result.snapshot;
}

function target(tabId: number, snapshotId: string, ref: number): GroundedTarget {
  return { tabId, snapshotId: snapshotId as GroundedTarget["snapshotId"], ref };
}

const LIVE: FrameIdentity = { documentEpoch: 0, navigationEpoch: 0 };

function expectResolved(result: TargetLookupResult): GroundingRecord {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  return result.grounding;
}

function expectStale(result: TargetLookupResult, targetValue: GroundedTarget): void {
  expect(result).toEqual({ ok: false, code: "stale_ref", target: targetValue, reason: expect.any(String) });
}

describe("SnapshotStore", () => {
  test("commits distinct snapshot IDs with increasing versions in commit order", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const first = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));
    const second = expectCommitted(commit(store, 1, [observed(1, "a")], [grounding(1, [0], "a")]));

    expect(first.identity.snapshotId).toBe("snap-1");
    expect(first.identity.snapshotVersion).toBe(1);
    expect(second.identity.snapshotId).toBe("snap-2");
    expect(second.identity.snapshotVersion).toBe(2);
    expect(first.identity.snapshotId).not.toBe(second.identity.snapshotId);
  });

  test("starts snapshotVersion at 1 for every tab", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const tabOne = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));
    const tabTwo = expectCommitted(commit(store, 2, [observed(1, "button")], [grounding(1, [0], "button")]));
    const tabOneAgain = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));

    expect(tabOne.identity.snapshotVersion).toBe(1);
    expect(tabTwo.identity.snapshotVersion).toBe(1);
    expect(tabOneAgain.identity.snapshotVersion).toBe(2);
  });

  test("carries the document and navigation epochs into the committed identity", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const snapshot = expectCommitted(
      commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")], {
        documentEpoch: 3,
        navigationEpoch: 5,
      }),
    );

    expect(snapshot.identity).toEqual({
      snapshotId: "snap-1",
      snapshotVersion: 1,
      documentEpoch: 3,
      navigationEpoch: 5,
    });
  });

  test("rejects duplicate ref numbers without committing or consuming a version", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));

    const duplicatedRefs = commit(
      store,
      1,
      [observed(1, "button"), observed(1, "a")],
      [grounding(1, [0], "button"), grounding(2, [1], "a")],
    );
    const duplicatedGroundings = commit(
      store,
      1,
      [observed(1, "button"), observed(2, "a")],
      [grounding(1, [0], "button"), grounding(1, [1], "a")],
    );

    expect(duplicatedRefs).toEqual({ ok: false, code: "duplicate_ref" });
    expect(duplicatedGroundings).toEqual({ ok: false, code: "duplicate_ref" });

    const next = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));
    expect(next.identity.snapshotVersion).toBe(2);
    expect(next.identity.snapshotId).toBe("snap-2");
  });

  test("rejects non-positive and non-integer ref numbers", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    expect(commit(store, 1, [observed(0, "button")], [grounding(1, [0], "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(-1, "button")], [grounding(1, [0], "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(1.5, "button")], [grounding(1, [0], "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(1, "button")], [grounding(0, [0], "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
  });

  test("rejects commits where public refs disagree with private groundings", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const differentRefSets = commit(store, 1, [observed(1, "button"), observed(2, "a")], [grounding(1, [0], "button")]);
    const differentTag = commit(store, 1, [observed(1, "button")], [grounding(1, [0], "a")]);
    const differentAttrs = commit(
      store,
      1,
      [observed(1, "button", { attrs: { type: "submit" } })],
      [grounding(1, [0], "button", { attrs: { type: "reset" } })],
    );
    const differentBounds = commit(
      store,
      1,
      [observed(1, "button", { bounds: { x: 1, y: 2, width: 3, height: 4 } })],
      [grounding(1, [0], "button", { bounds: { x: 9, y: 2, width: 3, height: 4 } })],
    );

    expect(differentRefSets).toEqual({ ok: false, code: "mismatched_grounding" });
    expect(differentTag).toEqual({ ok: false, code: "mismatched_grounding" });
    expect(differentAttrs).toEqual({ ok: false, code: "mismatched_grounding" });
    expect(differentBounds).toEqual({ ok: false, code: "mismatched_grounding" });
  });

  test("commits a page with no refs", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const snapshot = expectCommitted(commit(store, 1, [], []));

    expect(snapshot.identity.snapshotVersion).toBe(1);
    expect(snapshot.refs).toEqual([]);
    expect(snapshot.groundings).toEqual([]);
  });

  test("each grounded target returns only its own snapshot's recorded metadata", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const first = expectCommitted(
      commit(
        store,
        1,
        [observed(1, "button", { name: "Save", attrs: { type: "submit" } })],
        [grounding(1, [3, 1], "button", { name: "Save", attrs: { type: "submit" } })],
      ),
    );
    const second = expectCommitted(
      commit(
        store,
        1,
        [observed(1, "a", { name: "Read more", attrs: { href: "https://example.com" } })],
        [grounding(1, [7, 0], "a", { name: "Read more", attrs: { href: "https://example.com" } })],
      ),
    );

    const fromFirst = expectResolved(store.lookup(target(1, first.identity.snapshotId, 1), LIVE));
    const fromSecond = expectResolved(store.lookup(target(1, second.identity.snapshotId, 1), LIVE));

    expect(fromFirst.domPath).toEqual([3, 1]);
    expect(fromFirst.tag).toBe("button");
    expect(fromFirst.attrs).toEqual({ type: "submit" });
    expect(fromSecond.domPath).toEqual([7, 0]);
    expect(fromSecond.tag).toBe("a");
    expect(fromSecond.attrs).toEqual({ href: "https://example.com" });
  });

  test("lookup never falls back to another snapshot, tab, or ref", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const snapshot = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));

    const resolved = expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), LIVE));
    expect(resolved.domPath).toEqual([0]);

    expectStale(store.lookup(target(1, "snap-unknown", 1), LIVE), target(1, "snap-unknown", 1));
    expectStale(store.lookup(target(2, snapshot.identity.snapshotId, 1), LIVE), target(2, snapshot.identity.snapshotId, 1));

    const missing = store.lookup(target(1, snapshot.identity.snapshotId, 99), LIVE);
    expect(missing).toEqual({
      ok: false,
      code: "target_not_found",
      target: target(1, snapshot.identity.snapshotId, 99),
      reason: expect.any(String),
    });
  });

  test("evicts the ninth older snapshot and keeps the eight retained snapshots available", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const committed: CommittedSnapshot[] = [];
    for (let i = 0; i < 9; i += 1) {
      committed.push(expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")])));
    }

    expectStale(store.lookup(target(1, committed[0].identity.snapshotId, 1), LIVE), target(1, committed[0].identity.snapshotId, 1));
    for (const snapshot of committed.slice(1)) {
      expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), LIVE));
    }
  });

  test("invalidate disables the entire executable cache until a fresh commit", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const first = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));
    const second = expectCommitted(commit(store, 1, [observed(1, "a")], [grounding(1, [0], "a")]));

    store.invalidate(1);

    expectStale(store.lookup(target(1, first.identity.snapshotId, 1), LIVE), target(1, first.identity.snapshotId, 1));
    expectStale(store.lookup(target(1, second.identity.snapshotId, 1), LIVE), target(1, second.identity.snapshotId, 1));

    const third = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")]));
    expectResolved(store.lookup(target(1, third.identity.snapshotId, 1), LIVE));
    expectResolved(store.lookup(target(1, second.identity.snapshotId, 1), LIVE));
  });

  test("invalidate on a tab without snapshots also blocks lookups", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    store.invalidate(1);

    expectStale(store.lookup(target(1, "snap-unknown", 1), LIVE), target(1, "snap-unknown", 1));
  });

  test("compares document and navigation epochs before returning a record", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const snapshot = expectCommitted(
      commit(store, 1, [observed(1, "button")], [grounding(1, [0], "button")], {
        documentEpoch: 2,
        navigationEpoch: 3,
      }),
    );

    expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), { documentEpoch: 2, navigationEpoch: 3 }));
    expectStale(
      store.lookup(target(1, snapshot.identity.snapshotId, 1), { documentEpoch: 3, navigationEpoch: 3 }),
      target(1, snapshot.identity.snapshotId, 1),
    );
    expectStale(
      store.lookup(target(1, snapshot.identity.snapshotId, 1), { documentEpoch: 2, navigationEpoch: 4 }),
      target(1, snapshot.identity.snapshotId, 1),
    );
    expectStale(
      store.lookup(target(1, snapshot.identity.snapshotId, 1), { documentEpoch: 0, navigationEpoch: 0 }),
      target(1, snapshot.identity.snapshotId, 1),
    );
  });

  test("committed metadata is frozen and immune to later input mutation", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const refs = [observed(1, "button", { name: "Save", attrs: { type: "submit" } })];
    const groundings = [grounding(1, [0], "button", { name: "Save", attrs: { type: "submit" } })];

    const snapshot = expectCommitted(commit(store, 1, refs, groundings));

    refs.push(observed(2, "a"));
    refs[0].attrs.type = "reset";
    groundings[0].domPath.push(5);

    expect(snapshot.refs).toHaveLength(1);
    expect(snapshot.refs[0].attrs).toEqual({ type: "submit" });
    expect(snapshot.groundings[0].domPath).toEqual([0]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
    expect(Object.isFrozen(snapshot.refs)).toBe(true);
    expect(Object.isFrozen(snapshot.refs[0])).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0])).toBe(true);
  });
});