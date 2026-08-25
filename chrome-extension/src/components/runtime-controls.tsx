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
import { fetchAgentContextWindow, latestModelCall } from "@/lib/eve-runtime-metadata";
import type { MessageStreamEvent } from "eve/client";
import { useEffect, useMemo, useState } from "react";

export interface RuntimeControlsProps {
  readonly events: readonly MessageStreamEvent[];
}

export function RuntimeControls({ events }: RuntimeControlsProps) {
  const call = useMemo(() => latestModelCall(events), [events]);
  const [maxTokens, setMaxTokens] = useState<number | null>(null);

  useEffect(() => {
    if (maxTokens !== null) return;
    let active = true;
    void fetchAgentContextWindow(EVE_HOST).then((tokens) => {
      if (active) setMaxTokens(tokens);
    });
    return () => {
      active = false;
    };
  }, [call.modelId, maxTokens]);

  const usage = call.usage;
  const hasUsage = Boolean(
    usage &&
      (usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.cacheReadTokens !== undefined ||
        usage.cacheWriteTokens !== undefined),
  );
  const usedTokens = hasUsage
    ? (usage!.inputTokens ?? 0) +
      (usage!.outputTokens ?? 0) +
      (usage!.cacheReadTokens ?? 0) +
      (usage!.cacheWriteTokens ?? 0)
    : undefined;

  return (
    <div className="flex items-center gap-2">
      <ModelSelector model={call.modelId}>
        <ModelSelectorTrigger />
        <ModelSelectorContent>
          <ModelSelectorList>
            <ModelSelectorItem />
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelector>

      <Context
        maxTokens={maxTokens ?? undefined}
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
