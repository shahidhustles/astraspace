export const MODEL_OPTIONS = [
  {
    contextWindowTokens: 1_048_576,
    id: "muse-spark-1.2-contributor-free",
    label: "Muse Spark 1.2 Contributor Free",
    reasoningLabel: "XHigh reasoning, vision",
  },
  {
    contextWindowTokens: 1_050_000,
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    reasoningLabel: "Maximum reasoning, vision",
  },
  {
    contextWindowTokens: 200_000,
    id: "mimo-v2.5-free",
    label: "MiMo V2.5 Free",
    reasoningLabel: "Native reasoning, vision",
  },
  {
    contextWindowTokens: 190_000,
    id: "hy3-free",
    label: "Hy3 Free",
    reasoningLabel: "High reasoning, text only",
  },
  {
    contextWindowTokens: 262_144,
    id: "ling-3.0-flash-fin-free",
    label: "Ling 3.0 Flash Fin Free",
    reasoningLabel: "Native reasoning, text only",
  },
  {
    contextWindowTokens: 1_000_000,
    id: "nemotron-3-ultra-free",
    label: "Nemotron 3 Ultra Free",
    reasoningLabel: "Native reasoning, text only",
  },
  {
    contextWindowTokens: 262_144,
    id: "nemotron-3.5-lightning-free",
    label: "Nemotron 3.5 Lightning Free",
    reasoningLabel: "Native reasoning, text only",
  },
  {
    contextWindowTokens: 200_000,
    id: "big-pickle",
    label: "Big Pickle",
    reasoningLabel: "Native reasoning, text only",
  },
] as const;

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];

export const DEFAULT_MODEL_ID: ModelId = "muse-spark-1.2-contributor-free";

export function modelOption(modelId: ModelId) {
  return MODEL_OPTIONS.find((model) => model.id === modelId) ?? MODEL_OPTIONS[0];
}

export function modelOptionFromRuntimeId(modelId: string | null) {
  if (!modelId) return undefined;
  return MODEL_OPTIONS.find(
    (model) => model.id === modelId || modelId.endsWith(`/${model.id}`),
  );
}
