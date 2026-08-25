import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentModelSelectionDefinition } from "eve";

const ZEN_BASE_URL = "https://opencode.ai/zen/go/v1";
const zenOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: ZEN_BASE_URL,
});

const zenOpenAICompatible = createOpenAICompatible({
  name: "zen",
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
  "ox-alpha-free": {
    model: zenOpenAICompatible.chatModel("ox-alpha-free"),
    modelContextWindowTokens: 1_000_000,
    modelOptions: {
      providerOptions: {
        zen: { reasoningEffort: "max" },
      },
    },
  } satisfies AgentModelSelectionDefinition,
} as const;

export type ModelId = keyof typeof models;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.hasOwn(models, value);
}
