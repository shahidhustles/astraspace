export type ActionId = string & { readonly __brand: "ActionId" };

// Upper bound accepted for a caller-supplied wait.timeoutMs on one action.
export const MAX_WAIT_TIMEOUT_MS = 120_000;

// Queue deadline used when a request carries no explicit timeout.
export const DEFAULT_QUEUE_DEADLINE_MS = 30_000;

export function createActionId(): ActionId {
  return crypto.randomUUID() as ActionId;
}

export function toActionId(candidate: string): ActionId {
  return candidate as ActionId;
}
