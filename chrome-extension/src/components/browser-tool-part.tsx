import { MessageResponse } from "@/components/ai-elements/message";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { presentBrowserToolPart } from "@/lib/browser-tool-presentation";
import type { EveDynamicToolPart } from "eve/react";

export function BrowserToolPart({ part }: { readonly part: EveDynamicToolPart }) {
  const presentation = presentBrowserToolPart(part);
  if (presentation === null) return null;

  return (
    <Tool defaultOpen={presentation.defaultOpen}>
      <ToolHeader
        label={presentation.label}
        state={presentation.state}
        title={presentation.title}
        toolName={part.toolName}
        type="dynamic-tool"
      />
      <ToolContent>
        <ToolInput input={presentation.input} />
        <ToolOutput
          errorText={presentation.errorText}
          output={
            presentation.output === undefined ? undefined : (
              <MessageResponse>{presentation.output}</MessageResponse>
            )
          }
        />
      </ToolContent>
    </Tool>
  );
}
