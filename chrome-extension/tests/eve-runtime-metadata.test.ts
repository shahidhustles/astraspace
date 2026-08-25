import { describe, expect, test } from "bun:test";
import type { MessageStreamEvent } from "eve/client";
import {
  calculateUsedTokens,
  hasFirstAssistantToken,
} from "../src/lib/eve-runtime-metadata";

const META = { at: "2026-08-25T00:00:00.000Z", id: "event-1" };

function received(turnId: string): MessageStreamEvent {
  return {
    data: { message: "Hello", sequence: 0, turnId },
    meta: META,
    type: "message.received",
  };
}

function messageToken(turnId: string, messageDelta: string): MessageStreamEvent {
  return {
    data: {
      messageDelta,
      messageSoFar: messageDelta,
      sequence: 0,
      stepIndex: 0,
      turnId,
    },
    meta: META,
    type: "message.appended",
  };
}

function reasoningToken(turnId: string, reasoningDelta: string): MessageStreamEvent {
  return {
    data: {
      reasoningDelta,
      reasoningSoFar: reasoningDelta,
      sequence: 0,
      stepIndex: 0,
      turnId,
    },
    meta: META,
    type: "reasoning.appended",
  };
}

describe("calculateUsedTokens", () => {
  test("counts input and output without double-counting cache details", () => {
    expect(
      calculateUsedTokens({
        cacheReadTokens: 120,
        cacheWriteTokens: 5_859,
        inputTokens: 5_902,
        outputTokens: 8,
      }),
    ).toBe(5_910);
  });

  test("does not claim measured usage from cache details alone", () => {
    expect(calculateUsedTokens({ cacheReadTokens: 120 })).toBeUndefined();
  });
});

describe("hasFirstAssistantToken", () => {
  test("waits through submission and model startup", () => {
    expect(hasFirstAssistantToken([received("turn-1")], 0)).toBe(false);
  });

  test("accepts the first text or reasoning delta from the submitted turn", () => {
    expect(hasFirstAssistantToken([received("turn-1"), messageToken("turn-1", "H")], 0)).toBe(
      true,
    );
    expect(
      hasFirstAssistantToken([received("turn-1"), reasoningToken("turn-1", "T")], 0),
    ).toBe(true);
  });

  test("ignores late tokens from the turn being replaced", () => {
    const events = [
      messageToken("old-turn", "late"),
      received("new-turn"),
      messageToken("new-turn", "N"),
    ];

    expect(hasFirstAssistantToken(events, 0)).toBe(true);
    expect(hasFirstAssistantToken(events.slice(0, 2), 0)).toBe(false);
  });
});
