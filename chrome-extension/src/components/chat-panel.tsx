import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { RuntimeControls } from "@/components/runtime-controls";
import { EVE_HOST } from "@/lib/eve-config";
import {
  notifyEveSessionChanged,
  readStoredEveSession,
  storeEveSession,
} from "@/lib/eve-session";
import { hasFirstAssistantToken } from "@/lib/eve-runtime-metadata";
import { getLatestTodoSnapshot } from "@/lib/eve-todos";
import { DEFAULT_MODEL_ID, type ModelId } from "@/lib/model-catalog";
import {
  AssistantRuntimeProvider,
  type AppendMessage,
  type ExternalStoreMessageConverter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useEveAgent, type EveMessage } from "eve/react";
import { useCallback, useEffect, useState } from "react";

const MAX_TOOL_PAYLOAD_LENGTH = 2_000;
const stringifyToolPayload = (payload: unknown) => {
  try {
    const text = JSON.stringify(payload);
    return typeof text === "string"
      ? text.slice(0, MAX_TOOL_PAYLOAD_LENGTH)
      : "[unavailable tool payload]";
  } catch {
    return "[unavailable tool payload]";
  }
};

type ThreadContentPart = Exclude<ThreadMessageLike["content"], string>[number];

const convertEveMessage: ExternalStoreMessageConverter<EveMessage> = (
  message,
) => {
  const content: ThreadContentPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      content.push({ type: part.type, text: part.text });
      continue;
    }
    if (part.type !== "dynamic-tool") continue;
    const common = {
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      type: "tool-call" as const,
    };
    if (part.state === "input-streaming")
      content.push({ ...common, argsText: part.inputText });
    else if (part.state === "input-available")
      content.push({ ...common, argsText: stringifyToolPayload(part.input) });
    else if (part.state === "output-available")
      content.push({
        ...common,
        argsText: stringifyToolPayload(part.input),
        result: stringifyToolPayload(part.output),
      });
    else if (part.state === "output-error")
      content.push({
        ...common,
        argsText: stringifyToolPayload(part.input),
        result: part.errorText,
        isError: true,
      });
    else if (part.state === "output-denied")
      content.push({
        ...common,
        argsText: stringifyToolPayload(part.input),
        result: "Tool approval was denied.",
        isError: true,
      });
    else
      content.push({ ...common, argsText: stringifyToolPayload(part.input) });
  }
  return { id: message.id, role: message.role, content };
};

const messageText = (message: AppendMessage) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

export function ChatPanel() {
  const [restoredSessionId, setRestoredSessionId] = useState<
    string | null | undefined
  >(undefined);
  useEffect(() => {
    let cancelled = false;
    void readStoredEveSession().then((session) => {
      if (!cancelled) setRestoredSessionId(session?.sessionId ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (restoredSessionId === undefined)
    return <div aria-hidden className="h-full min-w-[280px] bg-background" />;
  return (
    <EveChatPanel
      key={restoredSessionId ?? "new"}
      restoredSessionId={restoredSessionId}
    />
  );
}

function EveChatPanel({
  restoredSessionId,
}: {
  readonly restoredSessionId: string | null;
}) {
  const agent = useEveAgent({
    host: EVE_HOST,
    initialSession:
      restoredSessionId === null
        ? undefined
        : { sessionId: restoredSessionId, streamIndex: 0 },
    resume: restoredSessionId !== null,
    onSessionChange(session) {
      if (session === undefined) {
        void storeEveSession(null);
        return;
      }
      void storeEveSession(session);
      void notifyEveSessionChanged(session.sessionId);
    },
  });
  const [modelId, setModelId] = useState<ModelId>(DEFAULT_MODEL_ID);
  const [sendFailed, setSendFailed] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [replyEventStartIndex, setReplyEventStartIndex] = useState<
    number | null
  >(null);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isAwaitingAssistant =
    isBusy &&
    replyEventStartIndex !== null &&
    !hasFirstAssistantToken(agent.events, replyEventStartIndex);
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = messageText(message);
      if (!text) return;
      setSendFailed(false);
      setReplyEventStartIndex(agent.events.length);
      try {
        await agent.send(text, {
          clientContext: { astraModelId: modelId },
          ...(isBusy ? { turnPolicy: "steer" as const } : {}),
        });
      } catch {
        setSendFailed(true);
      }
    },
    [agent, isBusy, modelId],
  );
  const onNewChat = useCallback(async () => {
    setResetting(true);
    try {
      if (isBusy) await agent.cancel();
      await storeEveSession(null);
      agent.reset();
      setSendFailed(false);
      setReplyEventStartIndex(null);
    } finally {
      setResetting(false);
    }
  }, [agent, isBusy]);
  const runtime = useExternalStoreRuntime({
    messages: agent.data.messages,
    isRunning: isBusy,
    isDisabled: agent.status === "resuming" || resetting,
    isSendDisabled: agent.status === "resuming" || resetting,
    onNew,
    onCancel: async () => {
      await agent.cancel();
    },
    convertMessage: convertEveMessage,
  });
  const todoSnapshot = getLatestTodoSnapshot(agent.data.messages);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {sendFailed || agent.status === "error" ? (
        <div
          className="absolute inset-x-3 top-14 z-10 rounded-lg border border-foreground/20 bg-background px-3 py-2 text-xs shadow-sm"
          role="alert"
        >
          Eve is unavailable. Check that Eve is running, then send the message
          again.
        </div>
      ) : null}
      <Thread
        composerTools={
          <RuntimeControls
            events={agent.events}
            modelId={modelId}
            onModelChange={setModelId}
          />
        }
        isAwaitingAssistant={isAwaitingAssistant}
        isNewChatDisabled={agent.status === "resuming" || resetting}
        onNewChat={() => {
          void onNewChat();
        }}
        todoSnapshot={todoSnapshot}
      />
    </AssistantRuntimeProvider>
  );
}
