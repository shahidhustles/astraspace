import { cn } from "@/lib/utils";
import { BotIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

// TODO(trusted-model-allowlist): The extension shows the single model the Eve
// agent reports. When multi-model routing ships, replace this boundary with a
// trusted backend allowlist and resolver. Never accept an arbitrary provider
// model id from the extension.

interface ModelSelectorValue {
  readonly model: string | null;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

const ModelSelectorContext = createContext<ModelSelectorValue | null>(null);

function useContextValue(): ModelSelectorValue {
  const value = useContext(ModelSelectorContext);
  if (!value) throw new Error("ModelSelector components must be used within ModelSelector");
  return value;
}

export type ModelSelectorProps = HTMLAttributes<HTMLDivElement> & {
  readonly model: string | null;
};

export function ModelSelector({ children, className, model, ...props }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ model, open, setOpen }), [model, open]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const container = containerRef.current;
      if (container && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <ModelSelectorContext.Provider value={value}>
      <div ref={containerRef} className={cn("relative", className)} {...props}>
        {children}
      </div>
    </ModelSelectorContext.Provider>
  );
}

export type ModelSelectorTriggerProps = ComponentProps<"button">;

export function ModelSelectorTrigger({ className, ...props }: ModelSelectorTriggerProps) {
  const { model, open, setOpen } = useContextValue();

  return (
    <button
      aria-expanded={open}
      aria-label={model ? `Model ${model}` : "Model not reported"}
      className={cn(
        "flex max-w-44 items-center gap-1.5 rounded-control border border-border-quiet bg-space-850 px-2.5 py-1 text-[11px] font-medium leading-[1.3] text-ink-200 transition-colors hover:bg-space-800 hover:text-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-950",
        className,
      )}
      onClick={() => setOpen(!open)}
      title={model ?? undefined}
      type="button"
      {...props}
    >
      <BotIcon aria-hidden className="size-3.5 shrink-0 text-ink-400" />
      <span className="truncate">{model ?? "Model not reported"}</span>
      <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-ink-600" />
    </button>
  );
}

export type ModelSelectorContentProps = HTMLAttributes<HTMLDivElement>;

export function ModelSelectorContent({ className, ...props }: ModelSelectorContentProps) {
  const { open } = useContextValue();
  if (!open) return null;

  return (
    <div
      className={cn(
        "absolute right-0 top-full z-20 mt-2 w-56 rounded-panel border border-border-quiet bg-space-900 p-1.5 shadow-dialog",
        className,
      )}
      {...props}
    />
  );
}

export type ModelSelectorListProps = HTMLAttributes<HTMLDivElement>;

export function ModelSelectorList({ className, ...props }: ModelSelectorListProps) {
  return <div className={cn("space-y-0.5", className)} {...props} />;
}

export type ModelSelectorItemProps = ComponentProps<"button">;

export function ModelSelectorItem({ className, ...props }: ModelSelectorItemProps) {
  const { model } = useContextValue();

  return (
    <button
      aria-current="true"
      className={cn(
        "flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-[12px] font-medium leading-[1.4] text-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-900",
        className,
      )}
      type="button"
      {...props}
    >
      {model ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-orbit-400" /> : null}
      <ModelSelectorName>{model ?? "Model not reported"}</ModelSelectorName>
    </button>
  );
}

export type ModelSelectorNameProps = ComponentProps<"span">;

export function ModelSelectorName({ className, ...props }: ModelSelectorNameProps) {
  return <span className={cn("truncate", className)} {...props} />;
}
