import type { EveDynamicToolPart } from "eve/react";

export type BrowserToolLabel =
  | "requested"
  | "running"
  | "completed"
  | "timed out"
  | "cancelled"
  | "failed";

export interface BrowserToolPresentation {
  readonly defaultOpen: boolean;
  readonly errorText?: string;
  readonly input: Record<string, unknown>;
  readonly label: BrowserToolLabel;
  readonly output?: string;
  readonly state: EveDynamicToolPart["state"];
  readonly title: string;
}

const BROWSER_TOOL_TITLES: Record<string, string> = {
  browser_back: "Go back",
  browser_clear_input: "Clear input",
  browser_click: "Click element",
  browser_close_tab: "Close tab",
  browser_get_select_options: "Read select options",
  browser_keypress: "Press key",
  browser_navigate: "Navigate",
  browser_observe: "Observe page",
  browser_open_tab: "Open tab",
  browser_refresh: "Refresh page",
  browser_scroll: "Scroll page",
  browser_scroll_to_text: "Find text",
  browser_select_option: "Select option",
  browser_switch_tab: "Switch tab",
  browser_type: "Type text",
};

const MAX_DEPTH = 3;
const MAX_ENTRIES = 12;
const MAX_STRING_LENGTH = 160;
const BLOCKED_KEYS = new Set(["data", "dom", "screenshot"]);

export function presentBrowserToolPart(
  part: EveDynamicToolPart,
): BrowserToolPresentation | null {
  const title = BROWSER_TOOL_TITLES[part.toolName];
  if (title === undefined) return null;

  const input = toSafeRecord(part.input);
  if (part.state === "input-streaming") {
    return { defaultOpen: false, input, label: "requested", state: part.state, title };
  }
  if (
    part.state === "input-available" ||
    part.state === "approval-requested" ||
    part.state === "approval-responded"
  ) {
    return { defaultOpen: true, input, label: "running", state: part.state, title };
  }
  if (part.state === "output-error") {
    const errorCode = errorCodeFromText(part.errorText);
    return {
      defaultOpen: true,
      errorText: [part.errorText, recoveryText({ errorCode, label: "failed" })]
        .filter(isNonNull)
        .join("\n\n"),
      input,
      label: "failed",
      state: part.state,
      title,
    };
  }
  if (part.state === "output-denied") {
    return {
      defaultOpen: true,
      input,
      label: "cancelled",
      output: "The tool call was not approved. Review the page before continuing.",
      state: part.state,
      title,
    };
  }
  return presentOutput({ input, output: part.output, part, title });
}

function presentOutput({
  input,
  output,
  part,
  title,
}: {
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly part: Extract<EveDynamicToolPart, { state: "output-available" }>;
  readonly title: string;
}): BrowserToolPresentation {
  const action = readRecord(output, "action");
  if (action !== null) return presentAction({ action, input, output, part, title });

  const observation = readRecord(output, "observation");
  if (observation !== null) {
    return {
      defaultOpen: false,
      input,
      label: "completed",
      output: observationSummary(observation),
      state: part.state,
      title,
    };
  }

  return {
    defaultOpen: true,
    input,
    label: "completed",
    output: "The browser tool returned a result.",
    state: part.state,
    title,
  };
}

function presentAction({
  action,
  input,
  output,
  part,
  title,
}: {
  readonly action: Record<string, unknown>;
  readonly input: Record<string, unknown>;
  readonly output: unknown;
  readonly part: Extract<EveDynamicToolPart, { state: "output-available" }>;
  readonly title: string;
}): BrowserToolPresentation {
  const observationError = readRecord(output, "observationError");
  const evidence = readRecord(action, "evidence");
  const evidenceStatus = evidence === null ? null : readString(evidence, "status");
  const error = readRecord(action, "error");
  const errorCode = error === null ? null : readString(error, "code");
  const label = actionLabel({ evidenceStatus, errorCode, ok: action.ok });
  const lines = [actionSummary(action, evidence)];
  if (observationError !== null) {
    lines.push("The action was sent, but Astra could not refresh the page. Observe it again before deciding what changed.");
  }
  const recovery = recoveryText({ errorCode, label });
  if (recovery !== null) lines.push(recovery);

  return {
    defaultOpen: label !== "completed",
    input,
    label,
    output: lines.join("\n\n"),
    state: part.state,
    title,
  };
}

function actionLabel({
  evidenceStatus,
  errorCode,
  ok,
}: {
  readonly evidenceStatus: string | null;
  readonly errorCode: string | null;
  readonly ok: unknown;
}): BrowserToolLabel {
  if (evidenceStatus === "timed_out") return "timed out";
  if (evidenceStatus === "cancelled" || errorCode === "action_cancelled") return "cancelled";
  if (evidenceStatus === "failed" || ok !== true) return "failed";
  return "completed";
}

function actionSummary(action: Record<string, unknown>, evidence: Record<string, unknown> | null): string {
  if (action.ok === true) {
    const tabId = readNumber(action, "tabId");
    const url = readString(action, "url");
    const status = evidence === null ? null : readString(evidence, "status");
    const target = [tabId === null ? null : `tab ${tabId}`, url].filter(isNonNull).join(" at ");
    return `${readString(action, "action") ?? "Browser action"} ${status ?? "completed"}${target.length > 0 ? ` on ${target}` : ""}.`;
  }
  const error = readRecord(action, "error");
  return error === null
    ? "The browser action failed."
    : `${readString(action, "action") ?? "Browser action"} failed${readString(error, "code") ? ` (${readString(error, "code")})` : ""}.`;
}

function observationSummary(observation: Record<string, unknown>): string {
  const tabId = readNumber(observation, "tabId");
  const title = readString(observation, "title");
  const url = readString(observation, "url");
  const refs = Array.isArray(observation.refs) ? observation.refs.length : 0;
  const snapshot = readRecord(observation, "snapshot");
  const snapshotId = snapshot === null ? null : readString(snapshot, "snapshotId");
  return [
    `Observed${tabId === null ? "" : ` tab ${tabId}`}${title === null ? "" : `, ${title}`}.`,
    url,
    `${refs} grounded ${refs === 1 ? "element" : "elements"}${snapshotId === null ? "" : ` in snapshot ${snapshotId}`}.`,
  ]
    .filter(isNonNull)
    .join("\n\n");
}

function recoveryText({
  errorCode,
  label,
}: {
  readonly errorCode: string | null;
  readonly label: BrowserToolLabel;
}): string | null {
  if (errorCode === "stale_ref" || errorCode === "target_not_found" || errorCode === "ambiguous_ref") {
    return "The page changed. Observe it again before another action.";
  }
  if (errorCode === "action_replay_uncertain") {
    return "The action may have run. Observe the page before trying it again.";
  }
  if (errorCode === "browser_unavailable") {
    return "Astra cannot reach the browser. Reopen a supported tab, then try again.";
  }
  if (label === "cancelled") return "The action stopped. Observe the page before continuing.";
  if (label === "timed out") return "The action was sent, but its completion check timed out. Observe the page before deciding what happened.";
  if (label === "failed") return "Check the page, then try again.";
  return null;
}

function errorCodeFromText(errorText: string): string | null {
  const match = /\b(action_replay_uncertain|browser_unavailable|stale_ref|target_not_found|ambiguous_ref|action_cancelled)\b/.exec(errorText);
  return match?.[1] ?? null;
}

function toSafeRecord(value: unknown): Record<string, unknown> {
  const safe = toSafeValue(value, 0);
  return isRecord(safe) ? safe : {};
}

function toSafeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => toSafeValue(item, depth + 1));
  if (!isRecord(value)) return String(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !BLOCKED_KEYS.has(key.toLowerCase()))
      .slice(0, MAX_ENTRIES)
      .map(([key, item]) => [key, toSafeValue(item, depth + 1)]),
  );
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}...`;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function readNumber(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === "number" ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}
