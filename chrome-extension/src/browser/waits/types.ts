import type { ActionExpectationPolicy } from "../actions/types";

export type ActionId = string & { readonly __brand: "ActionId" };

// Upper bound accepted for a caller-supplied wait.timeoutMs on one action.
export const MAX_WAIT_TIMEOUT_MS = 120_000;

// Queue deadline used when a request carries no explicit timeout.
export const DEFAULT_QUEUE_DEADLINE_MS = 30_000;

// Page-settling defaults. Timings are injectable so unit tests never sleep
// for production durations.
export const DOM_QUIET_WINDOW_MS = 300;

export const NETWORK_QUIET_WINDOW_MS = 500;

export const SETTLE_POLL_INTERVAL_MS = 50;

// Layout stability needs two samples separated by at least this span whose
// numeric measurements moved less than the tolerance.
export const LAYOUT_SAMPLE_SPAN_MS = 100;

export const LAYOUT_TOLERANCE_PX = 2;

export interface SettleTimings {
  domQuietMs: number;
  networkQuietMs: number;
  pollMs: number;
  layoutSampleSpanMs: number;
  layoutTolerancePx: number;
}

export function resolveSettleTimings(overrides?: Partial<SettleTimings>): SettleTimings {
  return {
    domQuietMs: DOM_QUIET_WINDOW_MS,
    networkQuietMs: NETWORK_QUIET_WINDOW_MS,
    pollMs: SETTLE_POLL_INTERVAL_MS,
    layoutSampleSpanMs: LAYOUT_SAMPLE_SPAN_MS,
    layoutTolerancePx: LAYOUT_TOLERANCE_PX,
    ...overrides,
  };
}

// Quiet means no relevant activity for the reported idle span.
export type NetworkSignal =
  | { status: "quiet"; idleMs: number; ignoredRequests: number }
  | { status: "activity_timeout"; timeoutMs: number; pendingCount: number; ignoredRequests: number }
  | { status: "cancelled"; ignoredRequests: number };

export type DomSignal =
  | { status: "quiet"; idleMs: number; watchedFrames: number }
  | { status: "activity_timeout"; timeoutMs: number; watchedFrames: number }
  | { status: "cancelled"; watchedFrames: number };

export interface ActionSettleSignals {
  network: NetworkSignal;
  dom: DomSignal;
}

// Time left on a caller-supplied wait timeout at dispatch start. Null means
// the caller set no explicit timeout, so settling has no extra cap.
export interface ActionDispatchBudget {
  timeoutMs: number | null;
  expectation: ActionExpectationPolicy | null;
}

// Abort handle, remaining budget, and parsed wait expectation threaded from the
// coordinator through dispatch into settling helpers.
export interface ActionSettleContext {
  signal: AbortSignal;
  timeoutMs: number | null;
  expectation: ActionExpectationPolicy | null;
}

export function createActionId(): ActionId {
  return crypto.randomUUID() as ActionId;
}

export function toActionId(candidate: string): ActionId {
  return candidate as ActionId;
}

// One recorded commit from the frame graph. `main_commit` is a new document
// on the main frame, `same_document` a route change without document swap,
// and `child_commit` the same document-swap signal for any child frame.
export type CommitKind = "main_commit" | "same_document" | "child_commit";

export interface NavigationCommitRecord {
  readonly kind: CommitKind;
  readonly frameId: string;
  readonly parentFrameId: string | null;
  readonly oldUrl: string;
  readonly newUrl: string;
  readonly loaderId: string;
  readonly documentEpoch: number;
  readonly navigationEpoch: number;
}

// Whether an action may complete on a same-document signal or needs a real
// document swap. Main-frame commits always count.
export interface CommitExpectation {
  acceptsSameDocument: boolean;
}

export type CommitWaitOutcome =
  | { status: "matched"; match: NavigationCommitRecord }
  | { status: "timeout"; timeoutMs: number }
  | { status: "cancelled" };

// Measured stability of the clicked tab's rendered geometry at settle time.
// Two samples separated by the configured span; position deltas below
// tolerance, or every rect gone (content unloaded), count as stable.
export type LayoutSignal =
  | { status: "stable"; samples: number; maxDeltaPx: number }
  | { status: "unstable"; timeoutMs: number; sampleCount: number; maxDeltaPx: number }
  | { status: "cancelled" };

// Where an accessible role/name search found matches.
export type ExpectationScope = "main_document" | "child_frame";

// How a wait.expectation policy resolved as completion evidence. Zero matches
// satisfies disappearance, one satisfies appearance, more satisfy neither.
// Scope records where the single satisfying match lives.
export type ExpectationSignal =
  | { status: "satisfied"; intent: "appear" | "disappear"; scope?: ExpectationScope }
  | { status: "ambiguous"; intent: "appear" | "disappear"; matches: number }
  | { status: "unresolved"; intent: "appear" | "disappear"; timeoutMs: number }
  | { status: "cancelled" };

// Tab opened by the click, matched to the source through openerTabId. The ID
// is a number|null, so JSON round-trips stay safe.
export interface PopupEvidence {
  newTabId: number | null;
}
