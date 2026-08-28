import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { BrowserToolPart } from "@/components/browser-tool-part";
import type { EveMessage } from "eve/react";

interface ChatMessageProps {
  message: EveMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const hasRenderablePart = message.parts.some(
    (part) =>
      part.type === "text" ||
      part.type === "reasoning" ||
      (part.type === "dynamic-tool" && part.toolName.startsWith("browser_")),
  );

  if (!hasRenderablePart) return null;

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <MessageResponse
                isAnimating={part.state === "streaming"}
                key={`${message.id}:text:${index}`}
              >
                {part.text}
              </MessageResponse>
            );
          }

          if (part.type === "reasoning") {
            return (
              <Reasoning
                defaultOpen
                isStreaming={part.state === "streaming"}
                key={`${message.id}:reasoning:${index}`}
              >
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }

          if (part.type === "dynamic-tool") {
            return <BrowserToolPart key={`${message.id}:tool:${index}`} part={part} />;
          }

          return null;
        })}
      </MessageContent>
    </Message>
  );
}
