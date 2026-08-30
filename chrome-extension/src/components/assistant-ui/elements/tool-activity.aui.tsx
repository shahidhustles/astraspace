import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { LoaderCircleIcon } from "lucide-react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";

type ToolInput = Readonly<Record<string, unknown>>;

function isToolInput(value: unknown): value is ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput(argsText: string): ToolInput {
  try {
    const parsed: unknown = JSON.parse(argsText);
    return isToolInput(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringInput(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function domainFromInput(input: ToolInput): string | undefined {
  const candidate = stringInput(input, "url") ?? stringInput(input, "domain");
  if (!candidate) return undefined;

  try {
    return new URL(candidate).hostname || undefined;
  } catch {
    return candidate;
  }
}

function displayToolName(toolName: string): string {
  return toolName.split("__").at(-1) ?? toolName;
}

function computerActivity(input: ToolInput): string {
  const action = stringInput(input, "action");
  const ref = stringInput(input, "ref");
  const direction = stringInput(input, "scroll_direction");

  switch (action) {
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click":
      return ref ? `Clicking ${ref}` : "Clicking in the browser";
    case "scroll":
      return direction ? `Scrolling ${direction}` : "Scrolling the page";
    case "scroll_to":
      return ref ? `Scrolling to ${ref}` : "Scrolling to the requested element";
    case "type":
      return ref ? `Typing into ${ref}` : "Typing in the browser";
    case "screenshot":
      return "Capturing the page";
    case "key":
      return "Pressing browser keys";
    case "hover":
      return ref ? `Hovering ${ref}` : "Hovering in the browser";
    case "wait":
      return "Waiting for the page";
    default:
      return "Using the browser";
  }
}

function toolActivity(toolName: string, argsText: string): string {
  const input = parseToolInput(argsText);

  switch (displayToolName(toolName)) {
    case "connection_search":
      return "Searching for the right browser tool";
    case "read_page": {
      const domain = domainFromInput(input);
      return domain
        ? `Reading page content: ${domain}`
        : "Reading page content";
    }
    case "computer":
      return computerActivity(input);
    case "navigate": {
      const domain = domainFromInput(input);
      return domain ? `Opening ${domain}` : "Opening the requested page";
    }
    case "tabs_context_mcp":
      return "Reading browser tabs";
    default:
      return `Using ${displayToolName(toolName).replaceAll("_", " ")}`;
  }
}

export const ToolActivity: ToolCallMessagePartComponent = (props) => {
  if (props.status.type !== "running" || props.result !== undefined) {
    return <ToolFallback {...props} />;
  }

  return (
    <div
      aria-live="polite"
      className="flex min-h-8 items-center gap-2 py-1 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircleIcon
        aria-hidden
        className="size-3.5 shrink-0 animate-spin"
      />
      <span className="shimmer motion-reduce:animate-none">
        {toolActivity(props.toolName, props.argsText)}
      </span>
      <span className="sr-only">Tool call in progress</span>
    </div>
  );
};
