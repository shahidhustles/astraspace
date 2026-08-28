import { defineAgent, defineDynamic, type AgentModelResolveContext } from "eve";
import { DEFAULT_MODEL_ID, resolveModel } from "./models";

const CLIENT_CONTEXT_PREFIX = "Client context:\n";

function modelIdFromContextMessage(content: string): string | null {
  if (!content.startsWith(CLIENT_CONTEXT_PREFIX)) return null;

  try {
    const context: unknown = JSON.parse(content.slice(CLIENT_CONTEXT_PREFIX.length));
    if (typeof context !== "object" || context === null || Array.isArray(context)) return null;

    const modelId = Reflect.get(context, "astraModelId");
    return typeof modelId === "string" && modelId.length > 0 ? modelId : null;
  } catch {
    return null;
  }
}

function selectedModelId(messages: AgentModelResolveContext["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || typeof message.content !== "string") continue;

    const modelId = modelIdFromContextMessage(message.content);
    if (modelId) return modelId;
  }

  return DEFAULT_MODEL_ID;
}

const dynamicModel = defineDynamic({
  events: {
    "step.started": (_event, context) => resolveModel(selectedModelId(context.messages)),
  },
});

export default defineAgent({
  model: dynamicModel,
});
