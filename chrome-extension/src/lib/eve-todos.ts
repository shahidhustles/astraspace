import type { EveMessage } from "eve/react";

export const TODO_TOOL_NAME = "todo";

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type TodoPriority = "high" | "medium" | "low";

export type TodoItem = {
  readonly content: string;
  readonly priority: TodoPriority;
  readonly status: TodoStatus;
};

export type TodoCounts = {
  readonly cancelled: number;
  readonly completed: number;
  readonly in_progress: number;
  readonly pending: number;
  readonly total: number;
};

export type TodoSnapshot = {
  readonly counts: TodoCounts;
  readonly todos: readonly TodoItem[];
};

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "cancelled"
  );
}

function isTodoPriority(value: unknown): value is TodoPriority {
  return value === "high" || value === "medium" || value === "low";
}

function calculateCounts(todos: readonly TodoItem[]): TodoCounts {
  const counts = {
    cancelled: 0,
    completed: 0,
    in_progress: 0,
    pending: 0,
    total: todos.length,
  };

  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}

function hasMatchingCounts(value: unknown, expected: TodoCounts): boolean {
  if (!isRecord(value)) return false;
  return (
    value.cancelled === expected.cancelled &&
    value.completed === expected.completed &&
    value.in_progress === expected.in_progress &&
    value.pending === expected.pending &&
    value.total === expected.total
  );
}

/** Validates the durable output shape returned by Eve's built-in todo tool. */
export function parseTodoSnapshot(value: unknown): TodoSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.todos)) return null;

  const todos: TodoItem[] = [];
  for (const item of value.todos) {
    if (!isRecord(item)) return null;
    if (
      typeof item.content !== "string" ||
      item.content.trim().length === 0 ||
      !isTodoPriority(item.priority) ||
      !isTodoStatus(item.status)
    ) {
      return null;
    }
    todos.push({
      content: item.content,
      priority: item.priority,
      status: item.status,
    });
  }

  const counts = calculateCounts(todos);
  return hasMatchingCounts(value.counts, counts) ? { counts, todos } : null;
}

/** Returns the latest terminal todo result from Eve's restored message history. */
export function getLatestTodoSnapshot(
  messages: readonly EveMessage[],
): TodoSnapshot | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex];
      if (
        !part ||
        part.type !== "dynamic-tool" ||
        part.toolName !== TODO_TOOL_NAME ||
        part.state !== "output-available" ||
        part.partial === true
      ) {
        continue;
      }
      return parseTodoSnapshot(part.output);
    }
  }
  return null;
}
