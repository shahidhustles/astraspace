import { dispatchBrowserAction, type BrowserActionRuntime } from "../actions/dispatcher";
import type {
  ActionExpectationPolicy,
  BrowserActionCancelReply,
  BrowserActionName,
  BrowserActionRequest,
  BrowserActionResult,
  ScheduledAction,
} from "../actions/types";
import {
  DEFAULT_QUEUE_DEADLINE_MS,
  createActionId,
  type ActionAbortCause,
  type ActionCompletionEvidence,
  type ActionDispatchBudget,
  type ActionId,
} from "./types";

export interface ActionWorkInput {
  tabId: number;
  name: BrowserActionName;
  requestedId?: ActionId | null;
  deadlineMs?: number | null;
  expectation?: ActionExpectationPolicy | null;
  work: (signal: AbortSignal, budget: ActionDispatchBudget) => Promise<BrowserActionResult>;
}

interface Lane {
  readonly tabId: number;
  queue: QueueEntry[];
  tail: Promise<void>;
}

interface QueueEntry {
  readonly id: ActionId;
  readonly tabId: number;
  readonly name: BrowserActionName;
  readonly controller: AbortController;
  readonly work: (signal: AbortSignal, budget: ActionDispatchBudget) => Promise<BrowserActionResult>;
  readonly resolveSettled: (result: BrowserActionResult) => void;
  readonly deadlineMs: number | null;
  readonly expectation: ActionExpectationPolicy | null;
  readonly acceptedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  state: "queued" | "dispatching";
}

type DispatchOutcome =
  | { kind: "cancelled" }
  | { kind: "result"; result: BrowserActionResult }
  | { kind: "thrown"; error: unknown };

// Lifecycle aborts reuse existing error codes, with stable messages that name
// the cause. Tab removal maps to missing_tab; the other three all leave the
// page unusable, so they surface as selected_tab_unavailable.
type LifecycleAbortError =
  | { code: "missing_tab"; message: string }
  | { code: "selected_tab_unavailable"; message: string };

function lifecycleAbortError(cause: ActionAbortCause): LifecycleAbortError {
  switch (cause) {
    case "tab_removed":
      return { code: "missing_tab", message: "Tab closed during the action" };
    case "debugger_detached":
      return { code: "selected_tab_unavailable", message: "Debugger detached during the action" };
    case "connection_replaced":
      return { code: "selected_tab_unavailable", message: "Connection was replaced during the action" };
    case "runtime_cleanup":
      return { code: "selected_tab_unavailable", message: "Browser runtime cleaned up during the action" };
  }
}

// Serializes action work per tab. Each tab owns one FIFO lane and its own
// abort controllers, so actions on separate tabs never wait on each other.
export class TabActionCoordinator {
  private readonly lanes = new Map<number, Lane>();
  private readonly live = new Map<ActionId, QueueEntry>();

  get liveCount(): number {
    return this.live.size;
  }

  get queueCount(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.queue.length;
    }
    return total;
  }

  enqueue(input: ActionWorkInput): ScheduledAction {
    const id = input.requestedId ?? createActionId();
    if (this.live.has(id)) {
      return {
        ok: false,
        action: input.name,
        error: { code: "invalid_action", message: `actionId "${id}" is already active` },
      };
    }

    let resolveSettled!: (result: BrowserActionResult) => void;
    const settled = new Promise<BrowserActionResult>((resolve) => {
      resolveSettled = resolve;
    });

    const entry: QueueEntry = {
      id,
      tabId: input.tabId,
      name: input.name,
      controller: new AbortController(),
      work: input.work,
      resolveSettled,
      deadlineMs: input.deadlineMs ?? null,
      expectation: input.expectation ?? null,
      acceptedAt: Date.now(),
      deadlineTimer: null,
      state: "queued",
    };
    this.live.set(id, entry);

    const lane = this.obtainLane(input.tabId);
    lane.queue.push(entry);
    lane.tail = lane.tail.then(() => this.drain(lane));

    entry.deadlineTimer = setTimeout(() => this.expireQueued(entry), input.deadlineMs ?? DEFAULT_QUEUE_DEADLINE_MS);

    return { ok: true, actionId: id, settled };
  }

  cancel(id: ActionId): BrowserActionCancelReply {
    const entry = this.live.get(id);
    if (!entry) {
      return {
        ok: false,
        actionId: id,
        error: { code: "unknown_action_id", message: `No active action with id "${id}"` },
      };
    }

    const completion = this.cancelledEvidence(entry);
    this.retire(entry);
    if (entry.state === "queued") {
      this.removeQueued(entry);
      entry.resolveSettled({
        ok: false,
        action: entry.name,
        tabId: entry.tabId,
        error: {
          code: "action_cancelled",
          message: "Browser action was cancelled before dispatch",
          dispatchStarted: false,
        },
        completion,
      });
      return { ok: true, actionId: id, cancelled: true, dispatchStarted: false };
    }

    entry.controller.abort();
    return { ok: true, actionId: id, cancelled: true, dispatchStarted: true };
  }

  // Settles every queued and active action on one tab because its connection
  // is gone (tab closed, debugger detached, generation replaced). Queued
  // entries never run afterward.
  abortForTab(tabId: number, cause: ActionAbortCause): void {
    this.abortEntries([...this.live.values()].filter((entry) => entry.tabId === tabId), cause);
  }

  abortAll(cause: ActionAbortCause): void {
    this.abortEntries([...this.live.values()], cause);
  }

  private abortEntries(entries: QueueEntry[], cause: ActionAbortCause): void {
    for (const entry of entries) {
      const wasQueued = entry.state === "queued";
      this.retire(entry);
      if (wasQueued) {
        this.removeQueued(entry);
      } else {
        entry.controller.abort();
      }
      entry.resolveSettled({
        ok: false,
        action: entry.name,
        tabId: entry.tabId,
        error: lifecycleAbortError(cause),
        completion: {
          actionId: entry.id,
          status: "failed",
          elapsedMs: Date.now() - entry.acceptedAt,
        },
      });
    }
  }

  private cancelledEvidence(entry: QueueEntry): ActionCompletionEvidence {
    return {
      actionId: entry.id,
      status: "cancelled",
      elapsedMs: Date.now() - entry.acceptedAt,
    };
  }

  private obtainLane(tabId: number): Lane {
    const existing = this.lanes.get(tabId);
    if (existing) {
      return existing;
    }
    const lane: Lane = { tabId, queue: [], tail: Promise.resolve() };
    this.lanes.set(tabId, lane);
    return lane;
  }

  private async drain(lane: Lane): Promise<void> {
    while (lane.queue.length > 0) {
      const entry = lane.queue.shift();
      if (!entry) {
        return;
      }
      await this.dispatchEntry(entry);
    }
    // The lane ran dry with nothing in flight, so forget it. A later enqueue
    // for the same tab simply opens a fresh lane.
    if (lane.queue.length === 0 && this.lanes.get(lane.tabId) === lane) {
      this.lanes.delete(lane.tabId);
    }
  }

  private async dispatchEntry(entry: QueueEntry): Promise<void> {
    if (entry.state !== "queued") {
      return;
    }
    entry.state = "dispatching";
    this.clearDeadline(entry);

    let outcome: DispatchOutcome;
    try {
      outcome = await this.raceWork(entry);
    } catch (error) {
      outcome = { kind: "thrown", error };
    }

    let result: BrowserActionResult;
    switch (outcome.kind) {
      case "result":
        result = outcome.result;
        break;
      case "cancelled":
        result = {
          ok: false,
          action: entry.name,
          tabId: entry.tabId,
          error: {
            code: "action_cancelled",
            message: "Browser action was cancelled during dispatch",
            dispatchStarted: true,
          },
          completion: this.cancelledEvidence(entry),
        };
        break;
      case "thrown":
        result = {
          ok: false,
          action: entry.name,
          tabId: entry.tabId,
          error: { code: "action_failed", message: "Browser action failed" },
          completion: {
            actionId: entry.id,
            status: "failed",
            elapsedMs: Date.now() - entry.acceptedAt,
          },
        };
        break;
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled dispatch outcome: ${JSON.stringify(exhaustive)}`);
      }
    }

    this.live.delete(entry.id);
    entry.resolveSettled(result);
  }

  // Settles with whichever lands first: the action's own work or the abort
  // signal. The {once:true} listener removes itself on the abort path; the
  // work path removes it explicitly so nothing leaks into later cancels.
  private raceWork(entry: QueueEntry): Promise<DispatchOutcome> {
    const signal = entry.controller.signal;
    let onAbort: (() => void) | null = null;

    const cancelled = new Promise<DispatchOutcome>((resolve) => {
      onAbort = () => resolve({ kind: "cancelled" });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const detach = (): void => {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    };

    const natural = this.invokeWork(entry).then(
      (result): DispatchOutcome => ({ kind: "result", result }),
      (error): DispatchOutcome => ({ kind: "thrown", error }),
    );
    void natural.then(detach);

    return Promise.race([natural, cancelled]);
  }

  private invokeWork(entry: QueueEntry): Promise<BrowserActionResult> {
    const remaining =
      entry.deadlineMs === null ? null : Math.max(0, entry.deadlineMs - (Date.now() - entry.acceptedAt));
    try {
      return entry.work(entry.controller.signal, {
        timeoutMs: remaining,
        expectation: entry.expectation,
        actionId: entry.id,
        startedAtMs: entry.acceptedAt,
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private expireQueued(entry: QueueEntry): void {
    if (entry.state !== "queued") {
      return;
    }
    this.removeQueued(entry);
    this.live.delete(entry.id);
    entry.resolveSettled({
      ok: false,
      action: entry.name,
      tabId: entry.tabId,
      error: {
        code: "action_wait_timeout",
        message: "Queue deadline expired before the action was dispatched",
      },
      completion: {
        actionId: entry.id,
        status: "timed_out",
        elapsedMs: Date.now() - entry.acceptedAt,
      },
    });
  }

  private removeQueued(entry: QueueEntry): void {
    const lane = this.lanes.get(entry.tabId);
    if (!lane) {
      return;
    }
    const index = lane.queue.indexOf(entry);
    if (index >= 0) {
      lane.queue.splice(index, 1);
    }
  }

  private clearDeadline(entry: QueueEntry): void {
    if (entry.deadlineTimer !== null) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = null;
    }
  }

  private retire(entry: QueueEntry): void {
    this.clearDeadline(entry);
    this.live.delete(entry.id);
  }
}

// Schedules one parsed request onto a coordinator, binding dispatch to the
// given runtime. Runtime holders and the test factory share this mapping so
// envelope fields only get read in one place.
export function enqueueActionRequest(
  coordinator: TabActionCoordinator,
  request: BrowserActionRequest,
  tabId: number,
  runtime: BrowserActionRuntime,
): ScheduledAction {
  return coordinator.enqueue({
    tabId,
    name: request.action,
    requestedId: request.actionId,
    deadlineMs: request.wait?.timeoutMs ?? null,
    expectation: request.wait?.expectation ?? null,
    work: (signal, budget) =>
      dispatchBrowserAction(request, runtime, {
        signal,
        timeoutMs: budget.timeoutMs,
        expectation: budget.expectation,
        actionId: budget.actionId,
        startedAtMs: budget.startedAtMs,
      }),
  });
}
