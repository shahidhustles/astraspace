import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { browserLoopFixtureModel, FIXTURE_MODEL_ID } from "./lib/browser-fixture-model";

const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const goOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: GO_BASE_URL,
});
const zenOpenAI = createOpenAI({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: ZEN_BASE_URL,
});
const zenOpenAICompatible = createOpenAICompatible({
  apiKey: process.env.OPENCODE_API_KEY,
  baseURL: ZEN_BASE_URL,
  name: "opencode",
});

export const DEFAULT_MODEL_ID = "muse-spark-1.2-contributor-free";

export const models = {
  "gpt-5.6-luna": {
    model: goOpenAI.responses("gpt-5.6-luna"),
    modelContextWindowTokens: 1_050_000,
    modelOptions: {
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "max" },
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
  "mimo-v2.5-free": {
    model: zenOpenAICompatible.chatModel("mimo-v2.5-free"),
    modelContextWindowTokens: 200_000,
  },
  "hy3-free": {
    model: zenOpenAICompatible.chatModel("hy3-free"),
    modelContextWindowTokens: 190_000,
    modelOptions: {
      providerOptions: {
        opencode: { reasoningEffort: "high" },
      },
    },
  },
  "ling-3.0-flash-fin-free": {
    model: zenOpenAICompatible.chatModel("ling-3.0-flash-fin-free"),
    modelContextWindowTokens: 262_144,
  },
  "nemotron-3-ultra-free": {
    model: zenOpenAICompatible.chatModel("nemotron-3-ultra-free"),
    modelContextWindowTokens: 1_000_000,
  },
  "nemotron-3.5-lightning-free": {
    model: zenOpenAICompatible.chatModel("nemotron-3.5-lightning-free"),
    modelContextWindowTokens: 262_144,
  },
  "big-pickle": {
    model: zenOpenAICompatible.chatModel("big-pickle"),
    modelContextWindowTokens: 200_000,
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
