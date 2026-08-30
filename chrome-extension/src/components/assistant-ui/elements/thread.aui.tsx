import { AstraBlob } from "@/components/astra-blob";
import { Loader } from "@/components/ai-elements/loader";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolActivity } from "@/components/assistant-ui/elements/tool-activity.aui";
import { TodoChecklist } from "@/components/assistant-ui/elements/todo-checklist.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TODO_TOOL_NAME, type TodoSnapshot } from "@/lib/eve-todos";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  groupPartByType,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type GroupByContext,
  type PartState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  CornerDownLeftIcon,
  CopyIcon,
  SquareIcon,
  SquarePenIcon,
} from "lucide-react";
import type { FC, ReactNode } from "react";

const groupAssistantParts = groupPartByType({
  reasoning: ["group-reasoning"],
  "tool-call": ["group-tools"],
});

function groupAssistantPart(
  part: PartState,
  context?: GroupByContext,
): readonly ("group-reasoning" | "group-tools")[] {
  if (part.type === "tool-call" && part.toolName === TODO_TOOL_NAME) return [];
  return groupAssistantParts(part, context);
}

export type ThreadProps = {
  readonly composerTools: ReactNode;
  readonly isAwaitingAssistant: boolean;
  readonly isNewChatDisabled: boolean;
  readonly onNewChat: () => void;
  readonly todoSnapshot: TodoSnapshot | null;
};

export const Thread: FC<ThreadProps> = ({
  composerTools,
  isAwaitingAssistant,
  isNewChatDisabled,
  onNewChat,
  todoSnapshot,
}) => {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  return (
    <ThreadPrimitive.Root className="aui-root flex h-full min-w-[280px] flex-col bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-3">
        <TooltipIconButton
          aria-label="New chat"
          disabled={isNewChatDisabled}
          onClick={onNewChat}
          tooltip="New chat"
          variant="ghost"
        >
          <SquarePenIcon aria-hidden className="size-4" />
        </TooltipIconButton>
      </div>
      <TodoChecklist snapshot={todoSnapshot} />
      <ThreadPrimitive.Viewport
        autoScroll
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-3xl flex-1 flex-col px-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={(state) => state.thread.messages.length === 0}>
            <Welcome />
          </AuiIf>
          <div className="flex flex-col gap-6 py-5 empty:hidden">
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
            {isAwaitingAssistant ? (
              <div
                aria-live="polite"
                className="flex min-h-8 items-center px-1"
                role="status"
              >
                <Loader size="sm" />
              </div>
            ) : null}
          </div>
        </div>
        <ThreadPrimitive.ScrollToBottom asChild>
          <TooltipIconButton
            className="absolute bottom-4 left-1/2 -translate-x-1/2 border border-border bg-background shadow-sm"
            tooltip="Scroll to bottom"
            variant="ghost"
          >
            <ArrowDownIcon aria-hidden className="size-4" />
          </TooltipIconButton>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Viewport>
      <div className="relative z-10 shrink-0 bg-background px-3 py-3">
        {isRunning ? <WorkingCompanion /> : null}
        <Composer tools={composerTools} />
        <p className="mt-2 px-1 text-[11px] leading-[1.35] text-muted-foreground">
          Enter to send. Shift+Enter for a new line.
        </p>
      </div>
    </ThreadPrimitive.Root>
  );
};

const WorkingCompanion: FC = () => (
  <TooltipProvider delayDuration={150}>
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label="Astra is working"
          className="astra-working-companion absolute bottom-full left-1/2 z-20 mb-2 flex size-10 -translate-x-1/2 cursor-default items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="status"
          tabIndex={0}
        >
          <AstraBlob className="size-10" isComposing={false} isWorking />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">Astra is working</TooltipContent>
    </Tooltip>
  </TooltipProvider>
);

const Welcome: FC = () => {
  const isComposing = useAuiState((state) => !state.composer.isEmpty);
  return (
    <div className="flex flex-col items-center px-4 text-center">
      <AstraBlob isComposing={isComposing} />
      <h1 className="mt-4 text-xl font-medium tracking-tight">
        Start a conversation
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Tell Astra what you want to get done.
      </p>
    </div>
  );
};

const ThreadMessage: FC = () =>
  useAuiState((state) => state.message.role) === "user" ? (
    <UserMessage />
  ) : (
    <AssistantMessage />
  );
const UserMessage: FC = () => (
  <MessagePrimitive.Root className="flex justify-end">
    <div className="max-w-[85%] rounded-2xl bg-foreground px-3.5 py-2.5 text-sm text-background">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="group flex flex-col gap-2 text-sm leading-6">
    <MessagePrimitive.GroupedParts
      groupBy={groupAssistantPart}
    >
      {({ part, children }) => {
        switch (part.type) {
          case "group-tools":
            return (
              <ToolGroupRoot
                defaultOpen={part.status.type === "running"}
                openWhileActive={part.status.type === "running"}
                variant="ghost"
              >
                <ToolGroupTrigger
                  count={part.indices.length}
                  active={part.status.type === "running"}
                />
                <ToolGroupContent>{children}</ToolGroupContent>
              </ToolGroupRoot>
            );
          case "group-reasoning":
            const isReasoningStreaming = part.status.type === "running";
            return (
              <ReasoningRoot streaming={isReasoningStreaming} variant="ghost">
                <ReasoningTrigger active={isReasoningStreaming} />
                <ReasoningContent aria-busy={isReasoningStreaming}>
                  <ReasoningText>{children}</ReasoningText>
                </ReasoningContent>
              </ReasoningRoot>
            );
          case "text":
            return <MarkdownText />;
          case "reasoning":
            return <Reasoning {...part} />;
          case "tool-call":
            return part.toolName === TODO_TOOL_NAME
              ? null
              : part.toolUI ?? <ToolActivity {...part} />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
    <ActionBarPrimitive.Root className="-ml-1 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" variant="ghost">
          <CopyIcon aria-hidden className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
);

const Composer: FC<{ readonly tools: ReactNode }> = ({ tools }) => (
  <ComposerPrimitive.Root className="rounded-xl border border-border bg-card p-2 shadow-sm">
    <ComposerPrimitive.Input
      autoFocus
      className="min-h-12 w-full resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
      placeholder="Message Astra"
    />
    <div className="flex items-center justify-between gap-2 pt-2">
      <div className="min-w-0">{tools}</div>
      <div className="flex items-center gap-1">
        <AuiIf condition={(state) => state.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <TooltipIconButton tooltip="Stop reply" variant="ghost">
              <SquareIcon aria-hidden className="size-3.5 fill-current" />
            </TooltipIconButton>
          </ComposerPrimitive.Cancel>
        </AuiIf>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            className="h-7 w-9 rounded-lg bg-foreground text-background hover:bg-foreground/85"
            tooltip="Send message"
            variant="ghost"
          >
            <CornerDownLeftIcon aria-hidden className="size-4" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </div>
    </div>
  </ComposerPrimitive.Root>
);
