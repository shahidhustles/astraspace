import type { GroundingRecord, ObservedRef, RectBounds } from "./observation/types";
import type { GroundedTarget, SnapshotId, SnapshotIdentity } from "./types";

export interface SnapshotStoreDeps {
  createUuid: () => string;
}

export interface CommittedSnapshot {
  identity: SnapshotIdentity;
  dom: string;
  refs: readonly ObservedRef[];
  groundings: readonly GroundingRecord[];
}

export interface CommitInput {
  tabId: number;
  documentEpoch: number;
  navigationEpoch: number;
  dom: string;
  refs: ObservedRef[];
  groundings: GroundingRecord[];
}

export type CommitErrorCode = "invalid_ref" | "duplicate_ref" | "mismatched_grounding";

export type CommitResult =
  | { ok: true; snapshot: CommittedSnapshot }
  | { ok: false; code: CommitErrorCode };

interface TabSnapshotState {
  nextVersion: number;
  snapshots: Map<SnapshotId, CommittedSnapshot>;
}

export class SnapshotStore {
  private readonly tabs = new Map<number, TabSnapshotState>();
  private readonly deps: SnapshotStoreDeps;

  constructor(deps: SnapshotStoreDeps = { createUuid: () => crypto.randomUUID() }) {
    this.deps = deps;
  }

  commit(input: CommitInput): CommitResult {
    const validationError = validateRefMap(input.refs, input.groundings);
    if (validationError) {
      return { ok: false, code: validationError };
    }

    const tab = this.tabState(input.tabId);
    const snapshotId = this.deps.createUuid() as SnapshotId;
    const snapshot: CommittedSnapshot = Object.freeze({
      identity: Object.freeze({
        snapshotId,
        snapshotVersion: tab.nextVersion,
        documentEpoch: input.documentEpoch,
        navigationEpoch: input.navigationEpoch,
      }),
      dom: input.dom,
      refs: freezeRecords(structuredClone(input.refs)),
      groundings: freezeRecords(structuredClone(input.groundings)),
    });
    tab.snapshots.set(snapshotId, snapshot);
    tab.nextVersion += 1;
    return { ok: true, snapshot };
  }

  lookup(target: GroundedTarget): GroundingRecord | undefined {
    const snapshot = this.tabs.get(target.tabId)?.snapshots.get(target.snapshotId);
    return snapshot?.groundings.find((grounding) => grounding.ref === target.ref);
  }

  private tabState(tabId: number): TabSnapshotState {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = { nextVersion: 1, snapshots: new Map() };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }
}

function validateRefMap(refs: ObservedRef[], groundings: GroundingRecord[]): CommitErrorCode | null {
  if (!refs.every((r) => isValidRefNumber(r.ref)) || !groundings.every((g) => isValidRefNumber(g.ref))) {
    return "invalid_ref";
  }
  if (hasDuplicates(refs.map((r) => r.ref)) || hasDuplicates(groundings.map((g) => g.ref))) {
    return "duplicate_ref";
  }

  const observedByRef = new Map(refs.map((r) => [r.ref, r]));
  const groundingByRef = new Map(groundings.map((g) => [g.ref, g]));
  if (observedByRef.size !== groundingByRef.size) {
    return "mismatched_grounding";
  }
  for (const [ref, observed] of observedByRef) {
    const grounding = groundingByRef.get(ref);
    if (!grounding || !recordsAgree(observed, grounding)) {
      return "mismatched_grounding";
    }
  }
  return null;
}

function isValidRefNumber(ref: number): boolean {
  return Number.isInteger(ref) && ref > 0;
}

function hasDuplicates(values: number[]): boolean {
  return new Set(values).size !== values.length;
}

function recordsAgree(observed: ObservedRef, grounding: GroundingRecord): boolean {
  return (
    observed.tag === grounding.tag &&
    observed.role === grounding.role &&
    observed.name === grounding.name &&
    sameAttrs(observed.attrs, grounding.attrs) &&
    sameBounds(observed.bounds, grounding.bounds)
  );
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => b[key] === a[key]);
}

function sameBounds(a: RectBounds | null, b: RectBounds | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function freezeRecords<T extends object>(records: T[]): readonly T[] {
  return Object.freeze(records.map((record) => Object.freeze(record)));
}