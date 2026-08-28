"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolState = DynamicToolUIPart["state"];

export type ToolHeaderProps = {
  className?: string;
  readonly label: string;
  readonly state: ToolState;
  readonly title: string;
  readonly toolName: string;
  readonly type: "dynamic-tool";
};

const statusIcons: Record<ToolState, ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const ToolHeader = ({
  className,
  label,
  title,
  state,
  toolName: _toolName,
  type: _type,
  ...props
}: ToolHeaderProps) => {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon aria-hidden className="size-4 shrink-0 text-orbit-400" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-200">
          {title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-400">
          {statusIcons[state]}
          {label}
        </span>
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  readonly input: Record<string, unknown>;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="text-[11px] font-medium uppercase tracking-wide text-ink-600">
      Input
    </h4>
    <pre className="max-h-48 overflow-auto rounded-control border border-border-quiet bg-space-950 px-2.5 py-2 text-[12px] leading-[1.45] text-ink-400">
      {JSON.stringify(input, null, 2)}
    </pre>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  readonly errorText?: string;
  readonly output?: ReactNode;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (output === undefined && errorText === undefined) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-ink-600">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-control border px-2.5 py-2 text-[12px] leading-[1.45] [&_table]:w-full",
          errorText
            ? "border-block-400/30 bg-block-400/8 text-block-400"
            : "border-border-quiet bg-space-950 text-ink-400",
        )}
      >
        {errorText ?? output}
      </div>
    </div>
  );
};
