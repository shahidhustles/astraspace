import { dispatchBrowserAction, type BrowserActionRuntime } from "../actions/dispatcher";
import type {
  BrowserActionCancelReply,
  BrowserActionName,
  BrowserActionRequest,
  BrowserActionResult,
  ScheduledAction,
} from "../actions/types";
import {
  DEFAULT_QUEUE_DEADLINE_MS,
  createActionId,
  type ActionDispatchBudget,
  type ActionId,
} from "./types";

export interface ActionWorkInput {
  tabId: number;
  name: BrowserActionName;
  requestedId?: ActionId | null;
  deadlineMs?: number | null;
  work: (signal: AbortSignal, budget: ActionDispatchBudget) => Promise<BrowserActionResult>;
}

interface Lane {
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
  readonly acceptedAt: number;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  state: "queued" | "dispatching";
}

type DispatchOutcome =
  | { kind: "cancelled" }
  | { kind: "result"; result: BrowserActionResult }
  | { kind: "thrown"; error: unknown };

// Serializes action work per tab. Each tab owns one FIFO lane and its own
// abort controllers, so actions on separate tabs never wait on each other.
export class TabActionCoordinator {
  private readonly lanes = new Map<number, Lane>();
  private readonly live = new Map<ActionId, QueueEntry>();

  get liveCount(): number {
    return this.live.size;
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
      });
      return { ok: true, actionId: id, cancelled: true, dispatchStarted: false };
    }

    entry.controller.abort();
    return { ok: true, actionId: id, cancelled: true, dispatchStarted: true };
  }

  private obtainLane(tabId: number): Lane {
    const existing = this.lanes.get(tabId);
    if (existing) {
      return existing;
    }
    const lane: Lane = { queue: [], tail: Promise.resolve() };
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
        };
        break;
      case "thrown":
        result = {
          ok: false,
          action: entry.name,
          tabId: entry.tabId,
          error: { code: "action_failed", message: "Browser action failed" },
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
      return entry.work(entry.controller.signal, { timeoutMs: remaining });
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
    work: (signal, budget) => dispatchBrowserAction(request, runtime, { signal, timeoutMs: budget.timeoutMs }),
  });
}
