import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import type { EveMessage } from "eve/react";

interface ChatMessageProps {
  message: EveMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const textParts = message.parts.filter((part) => part.type === "text");

  if (textParts.length === 0) return null;

  return (
    <Message from={message.role}>
      <MessageContent>
        {textParts.map((part, index) => (
          <MessageResponse
            isAnimating={part.state === "streaming"}
            key={`${message.id}:text:${index}`}
          >
            {part.text}
          </MessageResponse>
        ))}
      </MessageContent>
    </Message>
  );
}
