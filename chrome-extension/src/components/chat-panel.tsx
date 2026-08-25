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
import { Button } from "@/components/ui/button";
import { ChatMessage } from "@/components/chat-message";
import { EVE_HOST } from "@/lib/eve-config";
import { useEveAgent } from "eve/react";
import { SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState(false);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const hasError = sendFailed || agent.status === "error";

  useEffect(() => {
    if (!steering) return;
    if (agent.status === "ready" || agent.status === "error") {
      setSteering(false);
      return;
    }
    const lastEvent = agent.events[agent.events.length - 1];
    if (lastEvent?.type === "message.received") setSteering(false);
  }, [agent.events, agent.status, steering]);

  async function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (text.length === 0) return;

    setSendFailed(false);
    setStopped(false);
    setSteering(isBusy);
    setInput("");

    try {
      await agent.send(text, isBusy ? { turnPolicy: "steer" } : undefined);
    } catch {
      setSendFailed(true);
      setSteering(false);
      setInput((current) => (current.length === 0 ? text : current));
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      const result = await agent.cancel();
      if (result.status === "accepted") setStopped(true);
    } catch {
      setStopped(false);
    } finally {
      setStopping(false);
    }
  }

  const stateLabel = hasError
    ? "Unavailable"
    : steering
      ? "Replacing reply"
      : stopped
        ? "Stopped"
        : agent.status === "submitted"
          ? "Submitted"
          : agent.status === "streaming"
            ? "Replying"
            : "Ready";
  const stateDot = hasError
    ? "bg-block-400"
    : stopped
      ? "bg-caution-400"
      : isBusy || steering
        ? "bg-scan-400 status-dot-active"
        : "bg-orbit-400";

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
          <span aria-hidden className={`size-1.5 rounded-full ${stateDot}`} />
          <span className="text-[11px] font-medium leading-[1.3] text-ink-200">{stateLabel}</span>
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
          {isBusy ? (
            <Button
              aria-label="Stop the reply"
              className="size-10 text-block-400 hover:bg-block-400/10 hover:text-block-400"
              disabled={stopping}
              onClick={() => void handleStop()}
              size="icon"
              title="Stop the reply"
              type="button"
              variant="ghost"
            >
              <SquareIcon aria-hidden className="size-4 fill-current" />
            </Button>
          ) : null}
          <PromptInputSubmit disabled={input.trim().length === 0} status={agent.status} />
        </PromptInput>
        <p className="mt-2 px-1 text-[11px] leading-[1.35] text-ink-600">
          Enter to send. Shift+Enter for a new line.
        </p>
      </footer>
    </div>
  );
}
