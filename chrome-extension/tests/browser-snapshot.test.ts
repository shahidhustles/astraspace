import { describe, expect, test } from "bun:test";
import {
  SnapshotStore,
  type CommittedSnapshot,
  type CommitInput,
  type CommitResult,
} from "../src/browser/snapshot";
import type { FrameIdentity, FrameRecord } from "../src/browser/document-identity";
import type {
  CommittedGroundingRecord,
  FrameLineageStep,
  GroundingRecord,
  ObservedRef,
  PathStep,
} from "../src/browser/observation/types";
import type { GroundedTarget, TargetLookupResult } from "../src/browser/types";

function sequencedUuids(): () => string {
  let next = 0;
  return () => `snap-${(next += 1)}`;
}

function path(...indexes: number[]): PathStep[] {
  return indexes.map((index) => ({ kind: "child", index }));
}

function observed(ref: number, tag: string, overrides: Partial<ObservedRef> = {}): ObservedRef {
  return { ref, tag, role: null, name: null, attrs: {}, bounds: null, ...overrides };
}

function grounding(
  ref: number,
  domPath: PathStep[],
  tag: string,
  overrides: Partial<GroundingRecord> = {},
): GroundingRecord {
  return {
    ref,
    domPath,
    frameLineage: [{ frameId: "main", parentFrameId: null, documentEpoch: 0, navigationEpoch: 0 }],
    backendNodeId: null,
    cssSegments: [],
    xpathSegments: [],
    text: null,
    tag,
    role: null,
    name: null,
    attrs: {},
    disabled: false,
    bounds: null,
    ...overrides,
  };
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

const MAIN = "main";
const CHILD = "child";
const SIBLING = "sibling";
const PARENT = "parent";

function step(frameId: string, parentFrameId: string | null, overrides: Partial<FrameLineageStep> = {}): FrameLineageStep {
  return { frameId, parentFrameId, documentEpoch: 0, navigationEpoch: 0, ...overrides };
}

function record(frameId: string, overrides: Partial<FrameRecord> = {}): FrameRecord {
  return {
    frameId,
    parentFrameId: null,
    loaderId: "L",
    url: "",
    documentEpoch: 0,
    navigationEpoch: 0,
    ownerBackendNodeId: null,
    retired: false,
    ...overrides,
  };
}

function graph(records: Record<string, FrameRecord>): (frameId: string) => FrameRecord | null {
  return (frameId: string) => records[frameId] ?? null;
}

function expectResolved(result: TargetLookupResult): CommittedGroundingRecord {
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

    const first = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));
    const second = expectCommitted(commit(store, 1, [observed(1, "a")], [grounding(1, path(0), "a")]));

    expect(first.identity.snapshotId).toBe("snap-1");
    expect(first.identity.snapshotVersion).toBe(1);
    expect(second.identity.snapshotId).toBe("snap-2");
    expect(second.identity.snapshotVersion).toBe(2);
    expect(first.identity.snapshotId).not.toBe(second.identity.snapshotId);
  });

  test("starts snapshotVersion at 1 for every tab", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const tabOne = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));
    const tabTwo = expectCommitted(commit(store, 2, [observed(1, "button")], [grounding(1, path(0), "button")]));
    const tabOneAgain = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));

    expect(tabOne.identity.snapshotVersion).toBe(1);
    expect(tabTwo.identity.snapshotVersion).toBe(1);
    expect(tabOneAgain.identity.snapshotVersion).toBe(2);
  });

  test("carries the document and navigation epochs into the committed identity", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const snapshot = expectCommitted(
      commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")], {
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
    expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));

    const duplicatedRefs = commit(
      store,
      1,
      [observed(1, "button"), observed(1, "a")],
      [grounding(1, path(0), "button"), grounding(2, path(1), "a")],
    );
    const duplicatedGroundings = commit(
      store,
      1,
      [observed(1, "button"), observed(2, "a")],
      [grounding(1, path(0), "button"), grounding(1, path(1), "a")],
    );

    expect(duplicatedRefs).toEqual({ ok: false, code: "duplicate_ref" });
    expect(duplicatedGroundings).toEqual({ ok: false, code: "duplicate_ref" });

    const next = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));
    expect(next.identity.snapshotVersion).toBe(2);
    expect(next.identity.snapshotId).toBe("snap-2");
  });

  test("rejects non-positive and non-integer ref numbers", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    expect(commit(store, 1, [observed(0, "button")], [grounding(1, path(0), "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(-1, "button")], [grounding(1, path(0), "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(1.5, "button")], [grounding(1, path(0), "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
    expect(commit(store, 1, [observed(1, "button")], [grounding(0, path(0), "button")])).toEqual({
      ok: false,
      code: "invalid_ref",
    });
  });

  test("rejects commits where public refs disagree with private groundings", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const differentRefSets = commit(store, 1, [observed(1, "button"), observed(2, "a")], [grounding(1, path(0), "button")]);
    const differentTag = commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "a")]);
    const differentAttrs = commit(
      store,
      1,
      [observed(1, "button", { attrs: { type: "submit" } })],
      [grounding(1, path(0), "button", { attrs: { type: "reset" } })],
    );

    expect(differentRefSets).toEqual({ ok: false, code: "mismatched_grounding" });
    expect(differentTag).toEqual({ ok: false, code: "mismatched_grounding" });
    expect(differentAttrs).toEqual({ ok: false, code: "mismatched_grounding" });
  });

  test("commits when public viewport bounds differ from private frame-local bounds", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });

    const result = commit(
      store,
      1,
      [observed(1, "button", { bounds: { x: 108, y: 58, width: 90, height: 28 } })],
      [grounding(1, path(0), "button", { bounds: { x: 8, y: 8, width: 90, height: 28 } })],
    );

    expectCommitted(result);
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
        [grounding(1, path(3, 1), "button", { name: "Save", attrs: { type: "submit" } })],
      ),
    );
    const second = expectCommitted(
      commit(
        store,
        1,
        [observed(1, "a", { name: "Read more", attrs: { href: "https://example.com" } })],
        [grounding(1, path(7, 0), "a", { name: "Read more", attrs: { href: "https://example.com" } })],
      ),
    );

    const fromFirst = expectResolved(store.lookup(target(1, first.identity.snapshotId, 1), LIVE));
    const fromSecond = expectResolved(store.lookup(target(1, second.identity.snapshotId, 1), LIVE));

    expect(fromFirst.domPath).toEqual(path(3, 1));
    expect(fromFirst.tag).toBe("button");
    expect(fromFirst.attrs).toEqual({ type: "submit" });
    expect(fromSecond.domPath).toEqual(path(7, 0));
    expect(fromSecond.tag).toBe("a");
    expect(fromSecond.attrs).toEqual({ href: "https://example.com" });
  });

  test("lookup never falls back to another snapshot, tab, or ref", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const snapshot = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));

    const resolved = expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), LIVE));
    expect(resolved.domPath).toEqual(path(0));

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
      committed.push(expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")])));
    }

    expectStale(store.lookup(target(1, committed[0].identity.snapshotId, 1), LIVE), target(1, committed[0].identity.snapshotId, 1));
    for (const snapshot of committed.slice(1)) {
      expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), LIVE));
    }
  });

  test("invalidate disables the entire executable cache until a fresh commit", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const first = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));
    const second = expectCommitted(commit(store, 1, [observed(1, "a")], [grounding(1, path(0), "a")]));

    store.invalidate(1);

    expectStale(store.lookup(target(1, first.identity.snapshotId, 1), LIVE), target(1, first.identity.snapshotId, 1));
    expectStale(store.lookup(target(1, second.identity.snapshotId, 1), LIVE), target(1, second.identity.snapshotId, 1));

    const third = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")]));
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
      commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button")], {
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

  test("a child-frame change stales only that target's lineage while main and sibling targets stay eligible", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const main = record(MAIN);
    const child = record(CHILD, { parentFrameId: MAIN });
    const sibling = record(SIBLING, { parentFrameId: MAIN });
    const snapshot = expectCommitted(
      commit(
        store,
        1,
        [observed(1, "button"), observed(2, "button"), observed(3, "button")],
        [
          grounding(1, path(0), "button"),
          grounding(2, path(0), "button", {
            frameLineage: [step(MAIN, null), step(CHILD, MAIN)],
          }),
          grounding(3, path(0), "button", {
            frameLineage: [step(MAIN, null), step(SIBLING, MAIN)],
          }),
        ],
      ),
    );
    const targetAt = (ref: number) => target(1, snapshot.identity.snapshotId, ref);
    const live = graph({
      [MAIN]: main,
      [CHILD]: { ...child, navigationEpoch: 1 },
      [SIBLING]: sibling,
    });

    expectResolved(store.lookup(targetAt(1), LIVE, live));
    expectStale(store.lookup(targetAt(2), LIVE, live), targetAt(2));
    expectResolved(store.lookup(targetAt(3), LIVE, live));
  });

  test("a parent-frame change stales every recorded descendant target", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const main = record(MAIN);
    const parent = record(PARENT, { parentFrameId: MAIN });
    const child = record(CHILD, { parentFrameId: PARENT });
    const snapshot = expectCommitted(
      commit(
        store,
        1,
        [observed(1, "button"), observed(2, "button"), observed(3, "button")],
        [
          grounding(1, path(0), "button"),
          grounding(2, path(0), "button", {
            frameLineage: [step(MAIN, null), step(PARENT, MAIN)],
          }),
          grounding(3, path(0), "button", {
            frameLineage: [step(MAIN, null), step(PARENT, MAIN), step(CHILD, PARENT)],
          }),
        ],
      ),
    );
    const targetAt = (ref: number) => target(1, snapshot.identity.snapshotId, ref);

    const detached = graph({ [MAIN]: main });
    expectResolved(store.lookup(targetAt(1), LIVE, detached));
    expectStale(store.lookup(targetAt(2), LIVE, detached), targetAt(2));
    expectStale(store.lookup(targetAt(3), LIVE, detached), targetAt(3));

    const navigated = graph({
      [MAIN]: main,
      [PARENT]: { ...parent, documentEpoch: 1 },
      [CHILD]: child,
    });
    expectResolved(store.lookup(targetAt(1), LIVE, navigated));
    expectStale(store.lookup(targetAt(2), LIVE, navigated), targetAt(2));
    expectStale(store.lookup(targetAt(3), LIVE, navigated), targetAt(3));
  });

  test("empty-lineage groundings fall back to the main-frame epoch check", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const snapshot = expectCommitted(commit(store, 1, [observed(1, "button")], [grounding(1, path(0), "button", { frameLineage: [] })]));
    const t = target(1, snapshot.identity.snapshotId, 1);

    expectResolved(store.lookup(t, { documentEpoch: 0, navigationEpoch: 0 }, graph({})));
    expectStale(store.lookup(t, { documentEpoch: 5, navigationEpoch: 9 }, graph({})), t);
  });

  test("committed metadata is frozen and immune to later input mutation", () => {
    const store = new SnapshotStore({ createUuid: sequencedUuids() });
    const refs = [observed(1, "button", { name: "Save", attrs: { type: "submit" } })];
    const groundings = [grounding(1, path(0), "button", { name: "Save", attrs: { type: "submit" } })];

    const snapshot = expectCommitted(commit(store, 1, refs, groundings));

    refs.push(observed(2, "a"));
    refs[0].attrs.type = "reset";
    groundings[0].domPath.push({ kind: "child", index: 5 });
    groundings[0].frameLineage[0].documentEpoch = 9;
    groundings[0].cssSegments.push("body");

    expect(snapshot.refs).toHaveLength(1);
    expect(snapshot.refs[0].attrs).toEqual({ type: "submit" });
    expect(snapshot.groundings[0].domPath).toEqual(path(0));
    expect(snapshot.groundings[0].frameLineage).toEqual([
      { frameId: "main", parentFrameId: null, documentEpoch: 0, navigationEpoch: 0 },
    ]);
    expect(snapshot.groundings[0].cssSegments).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.identity)).toBe(true);
    expect(Object.isFrozen(snapshot.refs)).toBe(true);
    expect(Object.isFrozen(snapshot.refs[0])).toBe(true);
    expect(Object.isFrozen(snapshot.refs[0].attrs)).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0])).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].attrs)).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].domPath)).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].domPath[0])).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].frameLineage)).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].frameLineage[0])).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].cssSegments)).toBe(true);
    expect(Object.isFrozen(snapshot.groundings[0].xpathSegments)).toBe(true);

    expect(Reflect.set(snapshot.groundings[0].attrs, "type", "reset")).toBe(false);
    expect(Reflect.set(snapshot.groundings[0].domPath, "0", { kind: "child", index: 9 })).toBe(false);
    expect(Reflect.set(snapshot.groundings[0].frameLineage[0], "documentEpoch", 9)).toBe(false);
    const lookup = expectResolved(store.lookup(target(1, snapshot.identity.snapshotId, 1), LIVE));
    expect(lookup.attrs).toEqual({ type: "submit" });
    expect(lookup.domPath).toEqual(path(0));
    expect(lookup.frameLineage[0].documentEpoch).toBe(0);
  });
});
