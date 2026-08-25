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

export function latestModelCall(events: readonly MessageStreamEvent[]): EveModelCall {
  let modelId: string | null = null;
  let usage: EveStepUsage | null = null;

  for (const event of events) {
    if (event.type === "step.started") modelId = event.data.modelId;
    if (event.type === "step.completed" && event.data.usage) usage = event.data.usage;
  }

  return { modelId, usage };
}

export async function fetchAgentContextWindow(host: string): Promise<number | null> {
  try {
    const info = await new Client({ host }).info();
    const tokens = info.agent.model.contextWindowTokens;
    return typeof tokens === "number" && tokens > 0 ? tokens : null;
  } catch {
    return null;
  }
}
