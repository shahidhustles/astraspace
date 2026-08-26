import { lineageStepMatchesLive, type FrameIdentity, type FrameRecord } from "./document-identity";
import type {
  CommittedGroundingRecord,
  CommittedObservedRef,
  FrameLineageStep,
  GroundingRecord,
  ObservedRef,
  PathStep,
  RectBounds,
} from "./observation/types";
import type { GroundedTarget, SnapshotId, SnapshotIdentity, TargetLookupResult } from "./types";

export interface SnapshotStoreDeps {
  createUuid: () => string;
}

export interface CommittedSnapshot {
  readonly identity: Readonly<SnapshotIdentity>;
  readonly dom: string;
  readonly refs: readonly CommittedObservedRef[];
  readonly groundings: readonly CommittedGroundingRecord[];
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
  executable: boolean;
}

const MAX_RETAINED_SNAPSHOTS = 8;

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
      refs: Object.freeze(input.refs.map(freezeObservedRef)),
      groundings: Object.freeze(input.groundings.map(freezeGroundingRecord)),
    });
    tab.snapshots.set(snapshotId, snapshot);
    tab.nextVersion += 1;
    tab.executable = true;
    if (tab.snapshots.size > MAX_RETAINED_SNAPSHOTS) {
      const oldest = tab.snapshots.keys().next().value as SnapshotId;
      tab.snapshots.delete(oldest);
    }
    return { ok: true, snapshot };
  }

  lookup(
    target: GroundedTarget,
    live: FrameIdentity,
    record?: (frameId: string) => FrameRecord | null,
  ): TargetLookupResult {
    const tab = this.tabs.get(target.tabId);
    if (!tab || !tab.executable) {
      return {
        ok: false,
        code: "stale_ref",
        target,
        reason: tab ? "The tab's snapshot cache is invalidated" : "No snapshots for this tab",
      };
    }
    const snapshot = tab.snapshots.get(target.snapshotId);
    if (!snapshot) {
      return {
        ok: false,
        code: "stale_ref",
        target,
        reason: "The snapshot is not in the executable cache",
      };
    }
    const grounding = snapshot.groundings.find((entry) => entry.ref === target.ref);
    if (!grounding) {
      return {
        ok: false,
        code: "target_not_found",
        target,
        reason: `Snapshot does not own ref ${target.ref}`,
      };
    }
    if (record && grounding.frameLineage.length > 0) {
      if (!lineageMatches(grounding.frameLineage, record)) {
        return {
          ok: false,
          code: "stale_ref",
          target,
          reason: "The target's frame lineage no longer matches the live page",
        };
      }
      return { ok: true, grounding };
    }
    if (
      snapshot.identity.documentEpoch !== live.documentEpoch ||
      snapshot.identity.navigationEpoch !== live.navigationEpoch
    ) {
      return {
        ok: false,
        code: "stale_ref",
        target,
        reason: "The snapshot's epochs no longer match the live page",
      };
    }
    return { ok: true, grounding };
  }

  invalidate(tabId: number): void {
    this.tabState(tabId).executable = false;
  }

  private tabState(tabId: number): TabSnapshotState {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = { nextVersion: 1, snapshots: new Map(), executable: true };
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
    sameAttrs(observed.attrs, grounding.attrs)
  );
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => b[key] === a[key]);
}

function lineageMatches(
  lineage: readonly FrameLineageStep[],
  record: (frameId: string) => FrameRecord | null,
): boolean {
  for (const step of lineage) {
    if (!lineageStepMatchesLive(step, record(step.frameId))) {
      return false;
    }
  }
  return true;
}

function freezeObservedRef(record: ObservedRef): CommittedObservedRef {
  return Object.freeze({
    ...record,
    attrs: Object.freeze({ ...record.attrs }),
    bounds: freezeBounds(record.bounds),
  });
}

function freezeGroundingRecord(record: GroundingRecord): CommittedGroundingRecord {
  return Object.freeze({
    ...record,
    domPath: Object.freeze(record.domPath.map(freezePathStep)),
    frameLineage: Object.freeze(record.frameLineage.map(freezeLineageStep)),
    cssSegments: Object.freeze([...record.cssSegments]),
    xpathSegments: Object.freeze([...record.xpathSegments]),
    attrs: Object.freeze({ ...record.attrs }),
    bounds: freezeBounds(record.bounds),
  });
}

function freezePathStep(step: PathStep): Readonly<PathStep> {
  return Object.freeze({ ...step });
}

function freezeLineageStep(step: FrameLineageStep): Readonly<FrameLineageStep> {
  return Object.freeze({ ...step });
}

function freezeBounds(bounds: RectBounds | null): Readonly<RectBounds> | null {
  return bounds === null ? null : Object.freeze({ ...bounds });
}
