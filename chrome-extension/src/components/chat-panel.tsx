import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { AstraBlob } from "@/components/astra-blob";
import { ChatMessage } from "@/components/chat-message";
import { RuntimeControls } from "@/components/runtime-controls";
import { EVE_HOST } from "@/lib/eve-config";
import { hasFirstAssistantToken } from "@/lib/eve-runtime-metadata";
import { DEFAULT_MODEL_ID, type ModelId } from "@/lib/model-catalog";
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
  const [modelId, setModelId] = useState<ModelId>(DEFAULT_MODEL_ID);
  const [sendFailed, setSendFailed] = useState(false);
  const [steering, setSteering] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [replyEventStartIndex, setReplyEventStartIndex] = useState<number | null>(null);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const hasError = sendFailed || agent.status === "error";
  const isAwaitingAssistant =
    isBusy &&
    replyEventStartIndex !== null &&
    !hasFirstAssistantToken(agent.events, replyEventStartIndex);

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
    setSteering(isBusy);
    setReplyEventStartIndex(agent.events.length);
    setInput("");

    try {
      await agent.send(text, {
        clientContext: { astraModelId: modelId },
        ...(isBusy ? { turnPolicy: "steer" as const } : {}),
      });
    } catch {
      setSendFailed(true);
      setSteering(false);
      setInput((current) => (current.length === 0 ? text : current));
    }
  }

  async function handleStop() {
    setStopping(true);
    try {
      await agent.cancel();
    } catch {
      return;
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex h-full min-w-[280px] flex-col bg-space-950 text-ink-50">
      <header className="flex items-center border-b border-border-quiet bg-space-900 px-4 py-3 shadow-rim-panel">
        <div className="flex items-center gap-2.5">
          <Mark />
          <p className="text-[15px] font-medium leading-[1.35]">Astra Space</p>
        </div>
      </header>

      <Conversation aria-label="Conversation with Eve">
        <ConversationContent>
          {agent.data.messages.length === 0 ? (
            <ConversationEmptyState
              description="Tell Astra what you want to get done."
              title="Start a conversation"
            >
              <AstraBlob isComposing={input.trim().length > 0} />
            </ConversationEmptyState>
          ) : (
            agent.data.messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))
          )}
          {isAwaitingAssistant ? (
            <div aria-live="polite" className="flex min-h-8 items-center px-1" role="status">
              <Loader className="text-orbit-400" size="sm" variant="bars" />
            </div>
          ) : null}
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
              Check that Eve is running, then send the message again.
            </p>
          </div>
        ) : null}

        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              onChange={(event) => {
                setInput(event.currentTarget.value);
                if (hasError) setSendFailed(false);
              }}
              value={input}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <RuntimeControls
                events={agent.events}
                modelId={modelId}
                onModelChange={setModelId}
              />
            </PromptInputTools>
            <div className="flex items-center gap-1">
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
            </div>
          </PromptInputFooter>
        </PromptInput>
        <p className="mt-2 px-1 text-[11px] leading-[1.35] text-ink-600">
          Enter to send. Shift+Enter for a new line.
        </p>
      </footer>
    </div>
  );
}
