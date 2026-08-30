import { describe, expect, test } from "bun:test";
import type { EveMessage } from "eve/react";
import { reconcileTodoChecklistOpen } from "../src/components/assistant-ui/elements/todo-checklist.aui";
import {
  getLatestTodoSnapshot,
  parseTodoSnapshot,
  type TodoItem,
} from "../src/lib/eve-todos";

const todos: readonly TodoItem[] = [
  { content: "Inspect the page", priority: "high", status: "completed" },
  { content: "Add the item", priority: "medium", status: "in_progress" },
  { content: "Confirm the result", priority: "low", status: "pending" },
  { content: "Use unavailable coupon", priority: "low", status: "cancelled" },
];

const output = {
  counts: {
    cancelled: 1,
    completed: 1,
    in_progress: 1,
    pending: 1,
    total: 4,
  },
  todos,
};

function todoMessage(id: string, result: unknown): EveMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        input: { todos },
        output: result,
        state: "output-available",
        toolCallId: `call-${id}`,
        toolName: "todo",
        type: "dynamic-tool",
      },
    ],
  };
}

describe("parseTodoSnapshot", () => {
  test("validates all Eve todo states and summary counts", () => {
    expect(parseTodoSnapshot(output)).toEqual(output);
  });

  test("rejects malformed snapshots and inconsistent count summaries", () => {
    expect(parseTodoSnapshot({ todos: [] })).toBeNull();
    expect(
      parseTodoSnapshot({
        ...output,
        counts: { ...output.counts, total: 3 },
      }),
    ).toBeNull();
    expect(
      parseTodoSnapshot({
        ...output,
        todos: [{ content: "Missing status", priority: "high" }],
      }),
    ).toBeNull();
  });

  test("accepts an empty, terminal checklist", () => {
    expect(
      parseTodoSnapshot({
        counts: {
          cancelled: 0,
          completed: 0,
          in_progress: 0,
          pending: 0,
          total: 0,
        },
        todos: [],
      }),
    ).toEqual({
      counts: {
        cancelled: 0,
        completed: 0,
        in_progress: 0,
        pending: 0,
        total: 0,
      },
      todos: [],
    });
  });
});

describe("getLatestTodoSnapshot", () => {
  test("uses the latest completed todo result and ignores partial output", () => {
    const earlier = todoMessage("earlier", {
      counts: { cancelled: 0, completed: 0, in_progress: 1, pending: 0, total: 1 },
      todos: [{ content: "Earlier task", priority: "high", status: "in_progress" }],
    });
    const partial: EveMessage = {
      ...todoMessage("partial", output),
      parts: [
        {
          input: { todos },
          output,
          partial: true,
          state: "output-available",
          toolCallId: "call-partial",
          toolName: "todo",
          type: "dynamic-tool",
        },
      ],
    };

    expect(getLatestTodoSnapshot([earlier, partial, todoMessage("latest", output)])).toEqual(
      output,
    );
  });

  test("does not render a malformed latest todo result", () => {
    expect(getLatestTodoSnapshot([todoMessage("bad", { todos: [] })])).toBeNull();
  });
});

describe("todo checklist disclosure", () => {
  test("opens for active work, collapses when it completes, and preserves manual reopen", () => {
    expect(reconcileTodoChecklistOpen(false, false, true)).toBe(true);
    expect(reconcileTodoChecklistOpen(true, true, false)).toBe(false);
    expect(reconcileTodoChecklistOpen(true, false, false)).toBe(true);
  });
});
