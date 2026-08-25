import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { calculateUsedTokens, latestModelCall } from "@/lib/eve-runtime-metadata";
import {
  MODEL_OPTIONS,
  modelOption,
  modelOptionFromRuntimeId,
  type ModelId,
} from "@/lib/model-catalog";
import type { MessageStreamEvent } from "eve/client";
import { useMemo } from "react";

export interface RuntimeControlsProps {
  readonly events: readonly MessageStreamEvent[];
  readonly modelId: ModelId;
  readonly onModelChange: (modelId: ModelId) => void;
}

export function RuntimeControls({ events, modelId, onModelChange }: RuntimeControlsProps) {
  const call = useMemo(() => latestModelCall(events), [events]);
  const usage = call.usage;
  const usedTokens = calculateUsedTokens(usage);
  const selectedModel = modelOption(modelId);
  const usageModel = modelOptionFromRuntimeId(call.modelId) ?? selectedModel;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelSelector
        label={selectedModel.label}
        model={modelId}
        onModelChange={(nextModelId) => {
          const option = MODEL_OPTIONS.find((model) => model.id === nextModelId);
          if (option) onModelChange(option.id);
        }}
      >
        <ModelSelectorTrigger />
        <ModelSelectorContent>
          <ModelSelectorList>
            {MODEL_OPTIONS.map((model) => (
              <ModelSelectorItem
                description={model.reasoningLabel}
                key={model.id}
                label={model.label}
                value={model.id}
              />
            ))}
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      <Context
        maxTokens={usageModel.contextWindowTokens}
        usage={usage ?? undefined}
        usedTokens={usedTokens}
      >
        <ContextTrigger />
        <ContextContent>
          <ContextContentHeader />
          <ContextContentBody>
            <ContextInputUsage />
            <ContextOutputUsage />
            <ContextCacheUsage />
          </ContextContentBody>
        </ContextContent>
      </Context>
    </div>
  );
}
