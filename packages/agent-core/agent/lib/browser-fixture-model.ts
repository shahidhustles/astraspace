import type { MockModelToolResult } from "eve/evals";
import { mockModel } from "eve/evals";

export const FIXTURE_MODEL_ID = "browser-observe-fixture";

const OBSERVE_PROMPT_MARKER = "Inspect the current page";

export function browserObserveFixtureModel() {
  return mockModel((request) => {
    const observeResults = request.toolResults.filter(
      (entry) => entry.name === "browser_observe",
    );
    const observeAsks = request.userMessages.filter((message) =>
      message.includes(OBSERVE_PROMPT_MARKER),
    ).length;
    if (observeAsks > observeResults.length) {
      return { toolCalls: [{ name: "browser_observe", input: {} }] };
    }
    const lastResult = observeResults[observeResults.length - 1];
    if (lastResult) {
      return { text: digestObserveResult(lastResult) };
    }
    return { text: "fixture-ready" };
  });
}

function digestObserveResult(result: MockModelToolResult): string {
  if (result.isError) {
    const message = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    const code = /browser_observe failed \(([a-z_]+)\)/.exec(message ?? "")?.[1] ?? "unknown";
    return `BROWSER_OBSERVE_FAILED code=${code}`;
  }

  const parts: readonly unknown[] = Array.isArray(result.output) ? result.output : [];
  const textPart = parts.find((part) => fieldOf(part, "type") === "text");
  const filePart = parts.find((part) => fieldOf(part, "type") === "file");
  const text = textContent(textPart);
  const file = filePayload(filePart);

  if (text === null || file === null) {
    return `BROWSER_OBSERVE_MALFORMED text=${text !== null} file=${file !== null}`;
  }

  const snapshotId = /Snapshot: (\S+)/.exec(text)?.[1] ?? "missing";
  return [
    `BROWSER_OBSERVE_OK`,
    `mediaType=${file.mediaType}`,
    `jpegPrefix=${file.data.slice(0, 4)}`,
    `jpegBytes=${file.data.length}`,
    `textPartChars=${text.length}`,
    `snapshotId=${snapshotId}`,
    `---`,
    text.slice(0, 600),
  ].join(" ");
}

function textContent(part: unknown): string | null {
  const value = fieldOf(part, "text");
  return typeof value === "string" ? value : null;
}

function filePayload(part: unknown): { data: string; mediaType: string } | null {
  const mediaType = fieldOf(part, "mediaType");
  const data = fieldOf(part, "data");
  const payload = fieldOf(data, "data");
  if (typeof mediaType !== "string" || typeof payload !== "string") return null;
  return { data: payload, mediaType };
}

// ---- Complete-loop fixture model -------------------------------------------
//
// Drives the deterministic fixture page (eve-browser-control.html) through
// the real authored tools. The transcript's accumulated tool results carry
// all state: the latest observation text holds the current snapshot id, refs,
// typed input values, and the success row. Every step is derived from that
// text, so the same session can be re-prompted after a failure or restart.

const LOOP_PROMPT_MARKER = "Complete the loop form";
const STALE_PROMPT_MARKER = "Prove the stale ref is not reused";
const WAIT_PROMPT_MARKER = "Wait for the form result";

interface ObserveText {
  snapshotId: string;
  tabId: number;
  refs: { name: number; city: number; country: number; submit: number };
  hasNameValue: boolean;
  hasCityValue: boolean;
  hasCountryValue: boolean;
  hasSuccess: boolean;
  errorCode: string | null;
}

function parseObserveText(result: MockModelToolResult): ObserveText {
  const text =
    typeof result.output === "string"
      ? result.output
      : Array.isArray(result.output)
        ? String(fieldOf(result.output.find((part) => fieldOf(part, "type") === "text"), "text") ?? "")
        : JSON.stringify(result.output);
  const empty: ObserveText = {
    snapshotId: "",
    tabId: 0,
    refs: { name: -1, city: -1, country: -1, submit: -1 },
    hasNameValue: false,
    hasCityValue: false,
    hasCountryValue: false,
    hasSuccess: false,
    errorCode: null,
  };
  const snapshotId = /Snapshot: (\S+)/.exec(text)?.[1] ?? "";
  const tabId = Number(/Selected tab (\d+):/.exec(text)?.[1] ?? "0");
  const refs = { name: -1, city: -1, country: -1, submit: -1 };
  for (const match of text.matchAll(/\[(\d+)\]<[^>]*?(?:aria-label|role|id)=([^ >]+)/g)) {
    const ref = Number(match[1]);
    const label = (match[2] ?? "").replace(/^"|"$/g, "").toLowerCase();
    if (label.includes("name") && refs.name === -1) refs.name = ref;
    else if (label.includes("city") && refs.city === -1) refs.city = ref;
    else if (label.includes("country") && refs.country === -1) refs.country = ref;
    else if (label.includes("submit") && refs.submit === -1) refs.submit = ref;
  }
  return {
    ...empty,
    snapshotId,
    tabId,
    refs,
    hasNameValue: text.includes("value=Astra"),
    hasCityValue: text.includes("value=Oslo"),
    hasCountryValue: text.includes("value=greenland"),
    hasSuccess: text.includes("Form success") || text.includes("Submitted by"),
    errorCode:
      /browser_(observe|type|select_option|click|navigate) failed \(([a-z_]+)\)/.exec(text)?.[2] ?? null,
  };
}

function latestObservation(results: readonly MockModelToolResult[]): ObserveText | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    if (result && result.name === "browser_observe" && !result.isError) {
      return parseObserveText(result);
    }
  }
  return null;
}

function target(observe: ObserveText, ref: number) {
  return { tabId: observe.tabId, snapshotId: observe.snapshotId, ref };
}

export function browserLoopFixtureModel() {
  return mockModel((request) => {
    const prompt = request.userMessages.join(" ");
    const results = request.toolResults;

    if (
      !prompt.includes(LOOP_PROMPT_MARKER) &&
      !prompt.includes(STALE_PROMPT_MARKER) &&
      !prompt.includes(WAIT_PROMPT_MARKER)
    ) {
      return { text: "fixture-ready" };
    }

    const last = results[results.length - 1];
    const observe = latestObservation(results);

    // A typed failure is bounded and truthful: report it without retrying.
    if (last && last.isError) {
      const errorCode = parseObserveText(last).errorCode;
      if (errorCode === "stale_ref" && prompt.includes(STALE_PROMPT_MARKER)) {
        // The stale ref was rejected once. Observe again and continue with
        // the fresh ref; the mutation must not be replayed with the old one.
        return { toolCalls: [{ name: "browser_observe", input: {} }] };
      }
      if (
        errorCode === "selected_tab_unavailable" ||
        errorCode === "browser_unavailable" ||
        errorCode === "action_wait_timeout"
      ) {
        return { text: `LOOP_UNAVAILABLE code=${errorCode}` };
      }
      return { text: `LOOP_FAILED code=${errorCode}` };
    }

    if (observe !== null) {
      if (prompt.includes(STALE_PROMPT_MARKER)) {
        // Use the name ref once. After the extension rejects the stale ref
        // (the rerender mode replaced the button), re-observe and retype.
        if (!observe.hasNameValue && observe.refs.name !== -1) {
          return { toolCalls: [{ name: "browser_type", input: { target: target(observe, observe.refs.name), text: "first" } }] };
        }
        if (observe.hasNameValue) {
          return { text: "STALE_REF_PROVEN fresh=" + String(observe.refs.name) };
        }
        return { toolCalls: [{ name: "browser_observe", input: {} }] };
      }

      if (prompt.includes(WAIT_PROMPT_MARKER)) {
        if (observe.hasSuccess) {
          return { text: "WAIT_FORM_OK " + observeText(observe).slice(0, 400) };
        }
        if (observe.refs.submit !== -1) {
          return { toolCalls: [{ name: "browser_click", input: { target: target(observe, observe.refs.submit) } }] };
        }
        return { toolCalls: [{ name: "browser_observe", input: {} }] };
      }

      // "Complete the loop form"
      if (observe.hasSuccess) {
        return { text: "FORM_OK " + observeText(observe).slice(0, 400) };
      }
      if (!observe.hasNameValue && observe.refs.name !== -1) {
        return { toolCalls: [{ name: "browser_type", input: { target: target(observe, observe.refs.name), text: "Astra" } }] };
      }
      if (observe.hasNameValue && !observe.hasCityValue && observe.refs.city !== -1) {
        return { toolCalls: [{ name: "browser_type", input: { target: target(observe, observe.refs.city), text: "Oslo" } }] };
      }
      if (observe.hasCityValue && !observe.hasCountryValue && observe.refs.country !== -1) {
        return { toolCalls: [{ name: "browser_select_option", input: { target: target(observe, observe.refs.country), value: "greenland" } }] };
      }
      if (observe.hasCountryValue && observe.refs.submit !== -1) {
        return { toolCalls: [{ name: "browser_click", input: { target: target(observe, observe.refs.submit) } }] };
      }
    }

    // No usable observation yet: the first step of every loop.
    return { toolCalls: [{ name: "browser_observe", input: {} }] };
  });
}

function observeText(observe: ObserveText): string {
  return [
    `snapshot=${observe.snapshotId}`,
    `tab=${observe.tabId}`,
    `name=${observe.refs.name}`,
    `city=${observe.refs.city}`,
    `country=${observe.refs.country}`,
    `submit=${observe.refs.submit}`,
    `values=${observe.hasNameValue},${observe.hasCityValue},${observe.hasCountryValue}`,
    `success=${observe.hasSuccess}`,
  ].join(" ");
}

function fieldOf(part: unknown, key: string): unknown {
  if (typeof part !== "object" || part === null) return undefined;
  return Reflect.get(part, key);
}
