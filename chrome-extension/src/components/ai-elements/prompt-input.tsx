import { cn } from "@/lib/utils";
import { CornerDownLeftIcon } from "lucide-react";
import type { ComponentProps, FormEvent, FormEventHandler, KeyboardEventHandler } from "react";
import { useCallback, useState } from "react";

export interface PromptInputMessage {
  text: string;
  files: never[];
}

export type PromptInputProps = Omit<ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>,
  ) => void | Promise<void>;
};

export function PromptInput({ className, onSubmit, ...props }: PromptInputProps) {
  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const text = String(formData.get("message") ?? "");
      void onSubmit({ files: [], text }, event);
    },
    [onSubmit],
  );

  return (
    <form
      className={cn(
        "relative flex w-full items-end gap-2 rounded-panel border border-border-quiet bg-space-900 p-2 shadow-rim-panel focus-within:border-border-active focus-within:shadow-rim-active",
        className,
      )}
      onSubmit={handleSubmit}
      {...props}
    />
  );
}

export type PromptInputTextareaProps = ComponentProps<"textarea">;

export function PromptInputTextarea({ className, onKeyDown, ...props }: PromptInputTextareaProps) {
  const [isComposing, setIsComposing] = useState(false);
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey) return;
      if (isComposing || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    },
    [isComposing, onKeyDown],
  );

  return (
    <textarea
      aria-label="Message Eve"
      className={cn(
        "field-sizing-content max-h-40 min-h-12 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] leading-[1.5] text-ink-50 outline-none placeholder:text-ink-600",
        className,
      )}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder="Message the local agent"
      rows={1}
      {...props}
    />
  );
}

export type PromptInputSubmitProps = ComponentProps<"button"> & {
  status?: "error" | "ready" | "streaming" | "submitted";
};

export function PromptInputSubmit({
  className,
  status = "ready",
  ...props
}: PromptInputSubmitProps) {
  const isBusy = status === "submitted" || status === "streaming";
  const label = isBusy ? "Replace the current reply" : "Send message";

  return (
    <button
      aria-label={label}
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-control bg-orbit-500 text-ink-50 transition-colors hover:bg-orbit-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-space-950 disabled:cursor-not-allowed disabled:opacity-42",
        className,
      )}
      title={label}
      type="submit"
      {...props}
    >
      <CornerDownLeftIcon aria-hidden className="size-4" />
    </button>
  );
}
