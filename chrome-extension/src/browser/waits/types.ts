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

export interface SettleTimings {
  domQuietMs: number;
  networkQuietMs: number;
  pollMs: number;
}

export function resolveSettleTimings(overrides?: Partial<SettleTimings>): SettleTimings {
  return {
    domQuietMs: DOM_QUIET_WINDOW_MS,
    networkQuietMs: NETWORK_QUIET_WINDOW_MS,
    pollMs: SETTLE_POLL_INTERVAL_MS,
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
}

// Abort handle plus remaining budget threaded from the coordinator through
// dispatch into settling helpers.
export interface ActionSettleContext {
  signal: AbortSignal;
  timeoutMs: number | null;
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
