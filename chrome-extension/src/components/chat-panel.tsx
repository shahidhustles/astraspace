import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { ChatMessage } from "@/components/chat-message";
import { EVE_HOST } from "@/lib/eve-config";
import { useEveAgent } from "eve/react";
import { useState } from "react";

function Mark() {
  return (
    <span
      aria-hidden
      className="grid size-6 place-items-center rounded-control border border-border-quiet bg-space-850"
    >
      <span className="size-2 rounded-[2px] bg-orbit-400" />
    </span>
  );
}

export function ChatPanel() {
  const agent = useEveAgent({ host: EVE_HOST });
  const [input, setInput] = useState("");
  const [sendFailed, setSendFailed] = useState(false);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const hasError = sendFailed || agent.status === "error";

  async function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (text.length === 0 || isBusy) return;

    setSendFailed(false);
    setInput("");

    try {
      await agent.send(text);
    } catch {
      setSendFailed(true);
      setInput((current) => (current.length === 0 ? text : current));
    }
  }

  return (
    <div className="flex h-full min-w-[280px] flex-col bg-space-950 text-ink-50">
      <header className="flex items-center justify-between gap-3 border-b border-border-quiet bg-space-900 px-4 py-3 shadow-rim-panel">
        <div className="flex items-center gap-2.5">
          <Mark />
          <div>
            <p className="text-[15px] font-medium leading-[1.35]">Astra Space</p>
            <p className="text-[11px] leading-[1.35] text-ink-400">Local Eve session</p>
          </div>
        </div>
        <span
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-full border border-border-quiet bg-space-850 px-2.5 py-1"
        >
          <span
            aria-hidden
            className={
              hasError
                ? "size-1.5 rounded-full bg-block-400"
                : "size-1.5 rounded-full bg-orbit-400"
            }
          />
          <span className="text-[11px] font-medium leading-[1.3] text-ink-200">
            {hasError ? "Unavailable" : isBusy ? "Replying" : "Ready"}
          </span>
        </span>
      </header>

      <Conversation aria-label="Conversation with Eve">
        <ConversationContent>
          {agent.data.messages.length === 0 ? (
            <ConversationEmptyState
              description="Ask a question and watch Eve answer as the text arrives."
              title="Nothing sent yet"
            />
          ) : (
            agent.data.messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <footer className="border-t border-border-quiet bg-space-950 px-3 pb-3 pt-3">
        {hasError ? (
          <div
            className="mb-3 rounded-row border border-block-400/35 bg-block-400/8 px-3 py-2.5"
            role="alert"
          >
            <p className="text-[13px] font-medium leading-[1.4] text-block-400">
              Eve is unavailable
            </p>
            <p className="mt-1 text-[12px] leading-[1.45] text-ink-400">
              Start the local agent at 127.0.0.1:2000, then send the message again.
            </p>
          </div>
        ) : null}

        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            onChange={(event) => {
              setInput(event.currentTarget.value);
              if (hasError) setSendFailed(false);
            }}
            value={input}
          />
          <PromptInputSubmit
            disabled={input.trim().length === 0 || isBusy}
            status={agent.status}
          />
        </PromptInput>
        <p className="mt-2 px-1 text-[11px] leading-[1.35] text-ink-600">
          Enter to send. Shift+Enter for a new line.
        </p>
      </footer>
    </div>
  );
}
