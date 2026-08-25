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
