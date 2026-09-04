import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { browserLoopFixtureModel, FIXTURE_MODEL_ID } from "./lib/browser-fixture-model";

const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const goOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: GO_BASE_URL,
});
const goOpenAICompatible = createOpenAICompatible({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: GO_BASE_URL,
  name: "opencodeGo",
});
const zenOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: ZEN_BASE_URL,
});

export const DEFAULT_MODEL_ID = "muse-spark-1.3-contributor";

export const models = {
  "gpt-5.6-luna": {
    model: goOpenAI.responses("gpt-5.6-luna"),
    modelContextWindowTokens: 1_050_000,
    modelOptions: {
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "high" },
      },
    },
  },
  "glm-5.3-flash": {
    model: goOpenAICompatible.chatModel("glm-5.3-flash"),
    modelContextWindowTokens: 1_000_000,
    modelOptions: {
      providerOptions: {
        opencodeGo: { reasoningEffort: "max" },
      },
    },
  },
  "deepseek-v4-flash": {
    model: goOpenAICompatible.chatModel("deepseek-v4-flash"),
    modelContextWindowTokens: 1_000_000,
    modelOptions: {
      providerOptions: {
        opencodeGo: { reasoningEffort: "max" },
      },
    },
  },
  "muse-spark-1.3-contributor": {
    model: goOpenAI.responses("muse-spark-1.3-contributor"),
    modelContextWindowTokens: 1_048_576,
    modelOptions: {
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      },
    },
  },
  "muse-spark-1.2-contributor-free": {
    model: zenOpenAI.responses("muse-spark-1.2-contributor-free"),
    modelContextWindowTokens: 1_048_576,
    modelOptions: {
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      },
    },
  },
} as const;

export type ModelId = keyof typeof models;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.hasOwn(models, value);
}

export function resolveModel(id: string) {
  if (id === FIXTURE_MODEL_ID && process.env.ASTRA_FIXTURE_MODELS === "1") {
    return { model: browserLoopFixtureModel(), modelContextWindowTokens: 128_000 };
  }
  return isModelId(id) ? models[id] : models[DEFAULT_MODEL_ID];
}
