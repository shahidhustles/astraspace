import { streamdownPlugins } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";

interface ReasoningContextValue {
  readonly contentId: string;
  readonly duration: number | undefined;
  readonly isOpen: boolean;
  readonly isStreaming: boolean;
  readonly setIsOpen: (open: boolean) => void;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useContextValue(): ReasoningContextValue {
  const value = useContext(ReasoningContext);
  if (!value) throw new Error("Reasoning components must be used within Reasoning");
  return value;
}

export type ReasoningProps = HTMLAttributes<HTMLDivElement> & {
  readonly defaultOpen?: boolean;
  readonly duration?: number;
  readonly isStreaming?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
};

const AUTO_CLOSE_DELAY = 1000;

export function Reasoning({
  children,
  className,
  defaultOpen,
  duration: durationProp,
  isStreaming = false,
  onOpenChange,
  open,
  ...props
}: ReasoningProps) {
  const [internalOpen, setInternalOpen] = useState<boolean>(() => defaultOpen ?? isStreaming);
  const [internalDuration, setInternalDuration] = useState<number | undefined>(undefined);
  const [hasAutoClosed, setHasAutoClosed] = useState(false);
  const hasEverStreamedRef = useRef(isStreaming);
  const startTimeRef = useRef<number | null>(null);
  const contentId = useId();

  const isOpen = open ?? internalOpen;

  const setIsOpen = useCallback(
    (next: boolean) => {
      setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (isStreaming) {
      hasEverStreamedRef.current = true;
      if (startTimeRef.current === null) startTimeRef.current = Date.now();
    } else if (startTimeRef.current !== null) {
      setInternalDuration(Math.ceil((Date.now() - startTimeRef.current) / 1000));
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming && !isOpen && defaultOpen !== false) setIsOpen(true);
  }, [defaultOpen, isOpen, isStreaming, setIsOpen]);

  useEffect(() => {
    if (!hasEverStreamedRef.current || isStreaming || !isOpen || hasAutoClosed) return;
    const timer = window.setTimeout(() => {
      setHasAutoClosed(true);
      setIsOpen(false);
    }, AUTO_CLOSE_DELAY);
    return () => window.clearTimeout(timer);
  }, [hasAutoClosed, isOpen, isStreaming, setIsOpen]);

  const value = useMemo(
    () => ({
      contentId,
      duration: durationProp ?? internalDuration,
      isOpen,
      isStreaming,
      setIsOpen,
    }),
    [contentId, durationProp, internalDuration, isOpen, isStreaming, setIsOpen],
  );

  return (
    <ReasoningContext.Provider value={value}>
      <div className={cn("w-full min-w-0", className)} {...props}>
        {children}
      </div>
    </ReasoningContext.Provider>
  );
}

export type ReasoningTriggerProps = ComponentProps<"button"> & {
  readonly getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming) return "Thinking…";
  if (duration === undefined) return "Thought for a few seconds";
  if (duration === 0) return "Thought for less than a second";
  return `Thought for ${duration} seconds`;
};

export function ReasoningTrigger({
  children,
  className,
  getThinkingMessage = defaultGetThinkingMessage,
  onClick,
  ...props
}: ReasoningTriggerProps) {
  const { contentId, duration, isOpen, isStreaming, setIsOpen } = useContextValue();

  return (
    <button
      aria-controls={contentId}
      aria-expanded={isOpen}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-control px-1.5 py-1 text-left text-[13px] font-medium leading-[1.4] text-ink-400 transition-colors hover:bg-space-850 hover:text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-950",
        className,
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) setIsOpen(!isOpen);
      }}
      type="button"
      {...props}
    >
      {children ?? (
        <>
          <BrainIcon aria-hidden className="size-4 shrink-0 text-orbit-400" />
          <span className="min-w-0 flex-1 truncate">
            {getThinkingMessage(isStreaming, duration)}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-ink-600 transition-transform",
              isOpen ? "rotate-180" : "rotate-0",
            )}
          />
        </>
      )}
    </button>
  );
}

export type ReasoningContentProps = HTMLAttributes<HTMLDivElement> & {
  readonly children: string;
};

export function ReasoningContent({ children, className, ...props }: ReasoningContentProps) {
  const { contentId, isOpen } = useContextValue();

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "reasoning-content mt-2 rounded-row border border-border-quiet bg-space-900/70 px-3 py-2.5 text-[13px] leading-[1.55] text-ink-400",
        className,
      )}
      id={contentId}
      {...props}
    >
      <Streamdown className="message-response" plugins={streamdownPlugins}>
        {children}
      </Streamdown>
    </div>
  );
}
