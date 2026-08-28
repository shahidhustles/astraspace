import { createOpenAI } from "@ai-sdk/openai";
import type { AgentModelSelectionDefinition } from "eve";
import { browserLoopFixtureModel, FIXTURE_MODEL_ID } from "./lib/browser-fixture-model";

const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";
const zenOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: ZEN_BASE_URL,
});

export const DEFAULT_MODEL_ID = "gpt-5.6-luna";

export const models = {
  "gpt-5.6-luna": {
    model: zenOpenAI.responses("gpt-5.6-luna"),
    modelContextWindowTokens: 1_050_000,
    modelOptions: {
      providerOptions: {
        openai: { reasoningEffort: "medium" },
      },
    },
  } satisfies AgentModelSelectionDefinition,
  "muse-spark-1.2-contributor": {
    model: zenOpenAI.responses("muse-spark-1.2-contributor"),
    modelContextWindowTokens: 1_048_576,
  } satisfies AgentModelSelectionDefinition,
} as const;

export type ModelId = keyof typeof models;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.hasOwn(models, value);
}

export function resolveModel(id: string): AgentModelSelectionDefinition {
  if (id === FIXTURE_MODEL_ID && process.env.ASTRA_FIXTURE_MODELS === "1") {
    return { model: browserLoopFixtureModel(), modelContextWindowTokens: 128_000 };
  }
  return isModelId(id) ? models[id] : models[DEFAULT_MODEL_ID];
}
