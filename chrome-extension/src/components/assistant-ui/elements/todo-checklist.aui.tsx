"use client";

import { useEffect, useRef, useState, type FC } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { TodoItem, TodoSnapshot } from "@/lib/eve-todos";
import { cn } from "@/lib/utils";

type TodoChecklistProps = {
  readonly snapshot: TodoSnapshot | null;
};

export function reconcileTodoChecklistOpen(
  isOpen: boolean,
  wasActive: boolean,
  hasActiveTodo: boolean,
): boolean {
  return wasActive === hasActiveTodo ? isOpen : hasActiveTodo;
}

function activeTodo(snapshot: TodoSnapshot): TodoItem | undefined {
  return snapshot.todos.find((todo) => todo.status === "in_progress");
}

function summary(snapshot: TodoSnapshot): string {
  const { completed, total } = snapshot.counts;
  return `${completed} of ${total} complete`;
}

function StatusIcon({ status }: { readonly status: TodoItem["status"] }) {
  switch (status) {
    case "completed":
      return <CheckIcon aria-hidden className="size-3.5" />;
    case "in_progress":
      return <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin" />;
    case "cancelled":
      return <XIcon aria-hidden className="size-3.5" />;
    case "pending":
      return <CircleIcon aria-hidden className="size-3.5" />;
  }
}

function TodoRow({ todo }: { readonly todo: TodoItem }) {
  const isActive = todo.status === "in_progress";
  return (
    <li
      className={cn(
        "flex items-start gap-2 py-1.5 text-xs leading-5",
        todo.status === "completed" && "text-muted-foreground",
        todo.status === "cancelled" && "text-muted-foreground/70",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center",
          isActive && "text-foreground",
        )}
      >
        <StatusIcon status={todo.status} />
      </span>
      <span
        className={cn(
          "min-w-0",
          isActive && "shimmer motion-reduce:animate-none",
          todo.status === "completed" && "line-through",
          todo.status === "cancelled" && "line-through",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}

export const TodoChecklist: FC<TodoChecklistProps> = ({ snapshot }) => {
  const hasActiveTodo = (snapshot?.counts.in_progress ?? 0) > 0;
  const wasActive = useRef(hasActiveTodo);
  const [isOpen, setIsOpen] = useState(hasActiveTodo);

  useEffect(() => {
    const nextOpen = reconcileTodoChecklistOpen(
      isOpen,
      wasActive.current,
      hasActiveTodo,
    );
    if (nextOpen !== isOpen) {
      setIsOpen(nextOpen);
    }
    if (wasActive.current !== hasActiveTodo) {
      wasActive.current = hasActiveTodo;
    }
  }, [hasActiveTodo, isOpen]);

  if (!snapshot || snapshot.counts.total === 0) return null;

  const currentTodo = activeTodo(snapshot);
  return (
    <Collapsible
      className="shrink-0 border-b border-border bg-background"
      onOpenChange={setIsOpen}
      open={isOpen}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40">
        <span className={cn("font-medium", hasActiveTodo && "shimmer motion-reduce:animate-none")}>
          {summary(snapshot)}
        </span>
        {currentTodo ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {currentTodo.content}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-data-[state=closed]:-rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none">
        <ul className="max-h-44 overflow-y-auto border-t border-border px-3 py-1">
          {snapshot.todos.map((todo, index) => (
            <TodoRow key={`${todo.content}-${index}`} todo={todo} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
};
