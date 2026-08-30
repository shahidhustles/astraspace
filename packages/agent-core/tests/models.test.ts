import { describe, expect, test } from "bun:test";
import { models, resolveModel } from "../agent/models";

describe("OpenCode model routing", () => {
  test("forces Muse Spark reasoning at its highest supported effort", () => {
    expect(models["muse-spark-1.2-contributor-free"].modelOptions).toEqual({
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      },
    });
  });

  test("uses GPT 5.6 Luna's maximum reasoning effort", () => {
    expect(models["gpt-5.6-luna"].modelOptions).toEqual({
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "max" },
      },
    });
  });

  test("uses Hy3's highest supported compatible reasoning effort", () => {
    expect(models["hy3-free"].modelOptions).toEqual({
      providerOptions: {
        opencode: { reasoningEffort: "high" },
      },
    });
  });

  test("routes every supported free Zen model", () => {
    const freeModelIds = [
      "big-pickle",
      "hy3-free",
      "ling-3.0-flash-fin-free",
      "mimo-v2.5-free",
      "muse-spark-1.2-contributor-free",
      "nemotron-3-ultra-free",
      "nemotron-3.5-lightning-free",
    ] as const;

    for (const modelId of freeModelIds) {
      expect(resolveModel(modelId)).toBe(models[modelId]);
    }
  });
});
