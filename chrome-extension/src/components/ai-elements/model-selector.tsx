import { cn } from "@/lib/utils";
import { BotIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

interface ModelSelectorValue {
  readonly label: string;
  readonly model: string;
  readonly onModelChange: (model: string) => void;
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
  readonly label: string;
  readonly model: string;
  readonly onModelChange: (model: string) => void;
};

export function ModelSelector({
  children,
  className,
  label,
  model,
  onModelChange,
  ...props
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const value = useMemo(
    () => ({ label, model, onModelChange, open, setOpen }),
    [label, model, onModelChange, open],
  );

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
  const { label, open, setOpen } = useContextValue();

  return (
    <button
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-label={`Model ${label}`}
      className={cn(
        "flex max-w-44 items-center gap-1.5 rounded-control border border-border-quiet bg-space-850 px-2.5 py-1 text-[11px] font-medium leading-[1.3] text-ink-200 transition-colors hover:bg-space-800 hover:text-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-950",
        className,
      )}
      onClick={() => setOpen(!open)}
      title={label}
      type="button"
      {...props}
    >
      <BotIcon aria-hidden className="size-3.5 shrink-0 text-ink-400" />
      <span className="truncate">{label}</span>
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
      role="listbox"
      {...props}
    />
  );
}

export type ModelSelectorListProps = HTMLAttributes<HTMLDivElement>;

export function ModelSelectorList({ className, ...props }: ModelSelectorListProps) {
  return <div className={cn("space-y-0.5", className)} {...props} />;
}

export type ModelSelectorItemProps = Omit<ComponentProps<"button">, "value"> & {
  readonly description: string;
  readonly label: string;
  readonly value: string;
};

export function ModelSelectorItem({
  className,
  description,
  label,
  onClick,
  value,
  ...props
}: ModelSelectorItemProps) {
  const { model, onModelChange, setOpen } = useContextValue();
  const selected = model === value;

  return (
    <button
      aria-selected={selected}
      className={cn(
        "flex w-full items-start gap-2 rounded-control px-2 py-2 text-left text-[12px] font-medium leading-[1.4] text-ink-50 transition-colors hover:bg-space-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-900",
        className,
      )}
      onClick={(event) => {
        onModelChange(value);
        setOpen(false);
        onClick?.(event);
      }}
      role="option"
      type="button"
      {...props}
    >
      <span className="mt-0.5 grid size-3.5 shrink-0 place-items-center">
        {selected ? <CheckIcon aria-hidden className="size-3.5 text-orbit-400" /> : null}
      </span>
      <span className="min-w-0">
        <ModelSelectorName>{label}</ModelSelectorName>
        <span className="mt-0.5 block truncate text-[10px] font-normal text-ink-400">
          {description}
        </span>
      </span>
    </button>
  );
}

export type ModelSelectorNameProps = ComponentProps<"span">;

export function ModelSelectorName({ className, ...props }: ModelSelectorNameProps) {
  return <span className={cn("truncate", className)} {...props} />;
}
