import { cn } from "@/lib/utils";

export interface LoaderProps {
  readonly className?: string;
  readonly size?: "sm" | "md" | "lg";
}

const barWidths = {
  sm: "w-1",
  md: "w-1.5",
  lg: "w-2",
} satisfies Record<NonNullable<LoaderProps["size"]>, string>;

const containerSizes = {
  sm: "h-4 gap-1",
  md: "h-5 gap-1.5",
  lg: "h-6 gap-2",
} satisfies Record<NonNullable<LoaderProps["size"]>, string>;

export function Loader({ className, size = "md" }: LoaderProps) {
  return (
    <div className={cn("flex", containerSizes[size], className)}>
      {[0, 1, 2].map((index) => (
        <div
          className={cn(
            "h-full animate-[wave-bars_1.2s_ease-in-out_infinite] bg-orbit-400",
            barWidths[size],
          )}
          key={index}
          style={{ animationDelay: `${index * 0.2}s` }}
        />
      ))}
      <span className="sr-only">Eve is responding</span>
    </div>
  );
}
