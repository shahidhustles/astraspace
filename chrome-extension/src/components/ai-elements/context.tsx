import { cn } from "@/lib/utils";
import { GaugeIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useMemo } from "react";

export interface ContextUsage {
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

interface ContextValue {
  readonly maxTokens?: number;
  readonly usage?: ContextUsage;
  readonly usedTokens?: number;
}

const ContextContext = createContext<ContextValue | null>(null);

function useContextValue(): ContextValue {
  const value = useContext(ContextContext);
  if (!value) throw new Error("Context components must be used within Context");
  return value;
}

const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact" });
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" });

function formatTokens(value: number): string {
  return compactTokens.format(value);
}

function formatPercent(value: number): string {
  return percent.format(value);
}

export type ContextProps = HTMLAttributes<HTMLDivElement> & ContextValue;

export function Context({
  children,
  className,
  maxTokens,
  usage,
  usedTokens,
  ...props
}: ContextProps) {
  const value = useMemo(
    () => ({ maxTokens, usage, usedTokens }),
    [maxTokens, usage, usedTokens],
  );

  return (
    <ContextContext.Provider value={value}>
      <div className={cn("group/context relative", className)} {...props}>
        {children}
      </div>
    </ContextContext.Provider>
  );
}

export type ContextTriggerProps = ComponentProps<"button">;

export function ContextTrigger({ className, ...props }: ContextTriggerProps) {
  const { maxTokens, usedTokens } = useContextValue();
  const used = typeof usedTokens === "number" ? usedTokens : null;
  const max = typeof maxTokens === "number" ? maxTokens : null;
  const measured = used !== null && max !== null;
  const text = measured ? formatPercent(used / max) : "Not measured";

  return (
    <button
      aria-label={
        measured ? `Context window usage ${text}` : "Context window usage not measured"
      }
      className={cn(
        "flex items-center gap-1.5 rounded-control border border-border-quiet bg-space-850 px-2.5 py-1 text-[11px] font-medium leading-[1.3] text-ink-200 transition-colors hover:bg-space-800 hover:text-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-950",
        className,
      )}
      type="button"
      title={
        measured ? `${formatTokens(used)} / ${formatTokens(max)} tokens` : "Not measured"
      }
      {...props}
    >
      <GaugeIcon aria-hidden className="size-3.5 text-ink-400" />
      <span>{text}</span>
    </button>
  );
}

export type ContextContentProps = HTMLAttributes<HTMLDivElement>;

export function ContextContent({ className, ...props }: ContextContentProps) {
  return (
    <div
      className={cn(
        "invisible absolute right-0 top-full z-20 mt-2 w-60 rounded-panel border border-border-quiet bg-space-900 p-3 opacity-0 shadow-dialog transition-opacity duration-150 group-hover/context:visible group-hover/context:opacity-100 group-focus-within/context:visible group-focus-within/context:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export type ContextContentHeaderProps = HTMLAttributes<HTMLDivElement>;

export function ContextContentHeader({ className, ...props }: ContextContentHeaderProps) {
  const { maxTokens, usedTokens } = useContextValue();
  const used = typeof usedTokens === "number" ? usedTokens : null;
  const max = typeof maxTokens === "number" ? maxTokens : null;
  const measured = used !== null && max !== null;

  if (!measured) {
    return (
      <div className={cn("p-1", className)} {...props}>
        <p className="text-[13px] font-medium leading-[1.4] text-ink-50">Not measured</p>
        <p className="mt-1 text-[11px] leading-[1.4] text-ink-400">
          Usage or the context maximum is unavailable.
        </p>
      </div>
    );
  }

  const ratio = used / max;

  return (
    <div className={cn("p-1", className)} {...props}>
      <div className="flex items-center justify-between gap-3 text-[11px] font-medium leading-[1.35]">
        <span className="text-ink-50">{formatPercent(ratio)}</span>
        <span className="font-mono text-ink-400">
          {formatTokens(used)} / {formatTokens(max)}
        </span>
      </div>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-space-800">
        <div
          className="h-full rounded-full bg-orbit-400"
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

export type ContextContentBodyProps = HTMLAttributes<HTMLDivElement>;

export function ContextContentBody({ className, ...props }: ContextContentBodyProps) {
  const { usage } = useContextValue();
  const hasBreakdown = Boolean(
    usage &&
      (usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.cacheReadTokens !== undefined ||
        usage.cacheWriteTokens !== undefined),
  );

  if (!hasBreakdown) return null;

  return (
    <div
      className={cn("mt-3 space-y-1.5 border-t border-border-quiet pt-3", className)}
      {...props}
    />
  );
}

interface UsageRowProps {
  readonly className?: string;
  readonly label: string;
  readonly value: string;
}

function UsageRow({ className, label, value }: UsageRowProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 text-[11px] leading-[1.35]",
        className,
      )}
    >
      <span className="text-ink-400">{label}</span>
      <span className="font-mono text-ink-200">{value}</span>
    </div>
  );
}

export type ContextUsageRowProps = HTMLAttributes<HTMLDivElement>;

export function ContextInputUsage({ className }: ContextUsageRowProps) {
  const { usage } = useContextValue();
  const value = usage?.inputTokens;
  if (typeof value !== "number") return null;
  return <UsageRow className={className} label="Input tokens" value={formatTokens(value)} />;
}

export function ContextOutputUsage({ className }: ContextUsageRowProps) {
  const { usage } = useContextValue();
  const value = usage?.outputTokens;
  if (typeof value !== "number") return null;
  return <UsageRow className={className} label="Output tokens" value={formatTokens(value)} />;
}

export function ContextCacheUsage({ className }: ContextUsageRowProps) {
  const { usage } = useContextValue();
  const read = usage?.cacheReadTokens;
  const write = usage?.cacheWriteTokens;
  const readText = typeof read === "number" ? formatTokens(read) : null;
  const writeText = typeof write === "number" ? formatTokens(write) : null;
  if (readText === null && writeText === null) return null;
  let value: string;
  if (readText !== null && writeText !== null) {
    value = `${readText} / ${writeText}`;
  } else if (readText !== null) {
    value = readText;
  } else {
    value = writeText as string;
  }
  return <UsageRow className={className} label="Cache tokens" value={value} />;
}
