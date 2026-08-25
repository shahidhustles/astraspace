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
import { EVE_HOST } from "@/lib/eve-config";
import {
  calculateUsedTokens,
  fetchEveRuntimeMetadata,
  latestModelCall,
  type EveRuntimeMetadata,
} from "@/lib/eve-runtime-metadata";
import type { MessageStreamEvent } from "eve/client";
import { useEffect, useMemo, useState } from "react";

export interface RuntimeControlsProps {
  readonly events: readonly MessageStreamEvent[];
}

export function RuntimeControls({ events }: RuntimeControlsProps) {
  const call = useMemo(() => latestModelCall(events), [events]);
  const [runtimeMetadata, setRuntimeMetadata] = useState<EveRuntimeMetadata | null>(null);

  useEffect(() => {
    let active = true;
    void fetchEveRuntimeMetadata(EVE_HOST).then((metadata) => {
      if (active) setRuntimeMetadata(metadata);
    });
    return () => {
      active = false;
    };
  }, []);

  const usage = call.usage;
  const usedTokens = calculateUsedTokens(usage);
  const modelId = call.modelId ?? runtimeMetadata?.modelId ?? null;

  return (
    <div className="flex items-center gap-2">
      <ModelSelector model={modelId}>
        <ModelSelectorTrigger />
        <ModelSelectorContent>
          <ModelSelectorList>
            <ModelSelectorItem />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      <Context
        maxTokens={runtimeMetadata?.contextWindowTokens ?? undefined}
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
