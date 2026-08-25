import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: "assistant" | "user";
};

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div
      className={cn(
        "group flex w-full max-w-[92%] flex-col gap-2",
        from === "user" ? "is-user ml-auto items-end" : "is-assistant items-start",
        className,
      )}
      data-role={from}
      {...props}
    />
  );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export function MessageContent({ className, ...props }: MessageContentProps) {
  return (
    <div
      className={cn(
        "w-fit min-w-0 max-w-full overflow-hidden text-[14px] leading-[1.55] text-ink-200",
        "group-[.is-user]:rounded-row group-[.is-user]:border group-[.is-user]:border-border-active group-[.is-user]:bg-space-850 group-[.is-user]:px-3 group-[.is-user]:py-2.5 group-[.is-user]:text-ink-50",
        className,
      )}
      {...props}
    />
  );
}

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("message-response size-full", className)}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (previous, next) =>
    previous.children === next.children && previous.isAnimating === next.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
