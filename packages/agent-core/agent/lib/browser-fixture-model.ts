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

function fieldOf(part: unknown, key: string): unknown {
  if (typeof part !== "object" || part === null) return undefined;
  return Reflect.get(part, key);
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
