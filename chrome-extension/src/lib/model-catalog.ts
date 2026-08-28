export const MODEL_OPTIONS = [
  {
    contextWindowTokens: 1_050_000,
    id: "gpt-5.6-luna",
    label: "GPT 5.6 Luna",
    reasoningLabel: "Medium reasoning",
  },
  {
    contextWindowTokens: 1_048_576,
    id: "muse-spark-1.2-contributor",
    label: "Muse Spark 1.2 Contributor",
    reasoningLabel: "Provider default",
  },
] as const;

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];

export const DEFAULT_MODEL_ID: ModelId = "gpt-5.6-luna";

export function modelOption(modelId: ModelId) {
  return MODEL_OPTIONS.find((model) => model.id === modelId) ?? MODEL_OPTIONS[0];
}

export function modelOptionFromRuntimeId(modelId: string | null) {
  if (!modelId) return undefined;
  return MODEL_OPTIONS.find(
    (model) => model.id === modelId || modelId.endsWith(`/${model.id}`),
  );
}
