import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { DEFAULT_MODEL_ID, models, resolveModel } from "../agent/models";

describe("OpenCode model routing", () => {
  test("uses GPT 5.6 Luna's configured high reasoning effort", () => {
    expect(models["gpt-5.6-luna"].modelOptions).toEqual({
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "high" },
      },
    });
  });

  test("forces both Muse Spark models to their highest supported reasoning effort", () => {
    expect(models["muse-spark-1.3-contributor"].modelOptions).toEqual({
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      },
    });
    expect(models["muse-spark-1.2-contributor-free"].modelOptions).toEqual({
      providerOptions: {
        openai: { forceReasoning: true, reasoningEffort: "xhigh" },
      },
    });
  });

  test("uses maximum compatible reasoning for GLM Flash and DeepSeek Flash", () => {
    expect(models["glm-5.3-flash"].modelOptions).toEqual({
      providerOptions: {
        opencodeGo: { reasoningEffort: "max" },
      },
    });
    expect(models["deepseek-v4-flash"].modelOptions).toEqual({
      providerOptions: {
        opencodeGo: { reasoningEffort: "max" },
      },
    });
  });

  test("serializes compatible-provider reasoning effort in the Go request body", async () => {
    let requestBody: unknown;
    const testFetch = Object.assign(
      async (_input: URL | Request | string, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected the OpenAI-compatible request body to be a string");
        }
        requestBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: { content: "ok", role: "assistant" },
              },
            ],
            created: 0,
            id: "test-response",
            model: "glm-5.3-flash",
            object: "chat.completion",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      apiKey: "test-key",
      baseURL: "https://opencode.test/v1",
      fetch: testFetch,
      name: "opencodeGo",
    });

    await generateText({
      model: provider.chatModel("glm-5.3-flash"),
      prompt: "Reply with ok.",
      providerOptions: {
        opencodeGo: { reasoningEffort: "max" },
      },
    });

    expect(requestBody).toMatchObject({
      model: "glm-5.3-flash",
      reasoning_effort: "max",
    });
  });

  test("allows only the configured five-model catalog and falls back to Muse Spark 1.3", () => {
    expect(DEFAULT_MODEL_ID).toBe("muse-spark-1.3-contributor");

    const modelIds = [
      "deepseek-v4-flash",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "muse-spark-1.3-contributor",
      "muse-spark-1.2-contributor-free",
    ] as const;

    expect(Object.keys(models).sort()).toEqual([...modelIds].sort());
    for (const modelId of modelIds) {
      expect(resolveModel(modelId)).toBe(models[modelId]);
    }
    expect(resolveModel("hy3-free")).toBe(models[DEFAULT_MODEL_ID]);
  });

  test("routes Go chat models, Go Responses, and Zen Responses through their intended clients", () => {
    expect(models["glm-5.3-flash"].model.provider).toBe("opencodeGo.chat");
    expect(models["deepseek-v4-flash"].model.provider).toBe("opencodeGo.chat");
    expect(models["gpt-5.6-luna"].model.provider).toBe("openai.responses");
    expect(models["muse-spark-1.3-contributor"].model.provider).toBe("openai.responses");
    expect(models["muse-spark-1.2-contributor-free"].model.provider).toBe("openai.responses");
    expect(models["muse-spark-1.3-contributor"].model.modelId).toBe(
      "muse-spark-1.3-contributor",
    );
  });
});
