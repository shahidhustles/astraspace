import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export function Conversation({ className, ...props }: ConversationProps) {
  return (
    <StickToBottom
      className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
      initial="smooth"
      resize="smooth"
      role="log"
      {...props}
    />
  );
}

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export function ConversationContent({ className, ...props }: ConversationContentProps) {
  return (
    <StickToBottom.Content
      className={cn("flex min-h-full flex-col gap-5 px-4 py-6", className)}
      {...props}
    />
  );
}

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
};

export function ConversationEmptyState({
  className,
  title = "Start a conversation",
  description = "Ask a question. Replies stream in as they arrive.",
  ...props
}: ConversationEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex min-h-full flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      <h1 className="text-[20px] font-medium leading-[1.25] text-ink-50">{title}</h1>
      <p className="max-w-[30ch] text-[13px] leading-[1.45] text-ink-400">{description}</p>
    </div>
  );
}

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export function ConversationScrollButton({ className, ...props }: ConversationScrollButtonProps) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const handleScrollToBottom = useCallback(() => scrollToBottom(), [scrollToBottom]);

  return isAtBottom ? null : (
    <Button
      aria-label="Scroll to latest message"
      className={cn(
        "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-border-quiet bg-space-850 text-ink-200 hover:bg-space-800",
        className,
      )}
      onClick={handleScrollToBottom}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon aria-hidden className="size-4" />
    </Button>
  );
}
