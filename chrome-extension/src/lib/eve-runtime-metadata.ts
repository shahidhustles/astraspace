import { Client } from "eve/client";
import type { MessageStreamEvent } from "eve/client";

export interface EveStepUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface EveModelCall {
  readonly modelId: string | null;
  readonly usage: EveStepUsage | null;
}

export interface EveRuntimeMetadata {
  readonly contextWindowTokens: number | null;
  readonly modelId: string | null;
}

export function calculateUsedTokens(usage: EveStepUsage | null): number | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) {
    return undefined;
  }

  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

export function hasFirstAssistantToken(
  events: readonly MessageStreamEvent[],
  startIndex: number,
): boolean {
  let submittedTurnId: string | null = null;

  for (let index = startIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;

    if (submittedTurnId === null) {
      if (event.type === "message.received") submittedTurnId = event.data.turnId;
      continue;
    }

    if (event.type === "message.appended") {
      if (event.data.turnId === submittedTurnId && event.data.messageDelta.length > 0) {
        return true;
      }
      continue;
    }

    if (event.type === "message.completed") {
      if (event.data.turnId === submittedTurnId && (event.data.message?.length ?? 0) > 0) {
        return true;
      }
      continue;
    }

    if (
      (event.type === "reasoning.appended" || event.type === "reasoning.completed") &&
      event.data.turnId === submittedTurnId &&
      (event.type === "reasoning.appended"
        ? event.data.reasoningDelta.length > 0
        : event.data.reasoning.length > 0)
    ) {
      return true;
    }
  }

  return false;
}

export function latestModelCall(events: readonly MessageStreamEvent[]): EveModelCall {
  let modelId: string | null = null;
  let usage: EveStepUsage | null = null;

  for (const event of events) {
    if (event.type === "step.started") modelId = event.data.modelId;
    if (event.type === "step.completed" && event.data.usage) usage = event.data.usage;
  }

  return { modelId, usage };
}

export async function fetchEveRuntimeMetadata(host: string): Promise<EveRuntimeMetadata | null> {
  try {
    const info = await new Client({ host }).info();
    const model = info.agent.model;
    const contextWindowTokens =
      typeof model.contextWindowTokens === "number" && model.contextWindowTokens > 0
        ? model.contextWindowTokens
        : null;
    const modelId = typeof model.id === "string" ? model.id : null;

    return { contextWindowTokens, modelId };
  } catch {
    return null;
  }
}
