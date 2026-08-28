import { describe, expect, test } from "bun:test";
import { presentBrowserToolPart } from "../src/lib/browser-tool-presentation";
import type { EveDynamicToolPart } from "eve/react";

function browserPart(part: EveDynamicToolPart): EveDynamicToolPart {
  return part;
}

describe("browser tool presentation", () => {
  test("maps Eve's active lifecycle states without a second state machine", () => {
    const requested = presentBrowserToolPart(
      browserPart({
        input: undefined,
        state: "input-streaming",
        toolCallId: "call-requested",
        toolName: "browser_click",
        type: "dynamic-tool",
      }),
    );
    const running = presentBrowserToolPart(
      browserPart({
        input: { ref: 3 },
        state: "input-available",
        toolCallId: "call-running",
        toolName: "browser_click",
        type: "dynamic-tool",
      }),
    );

    expect(requested?.label).toBe("requested");
    expect(running?.label).toBe("running");
  });

  test("uses action evidence for timeout and cancellation", () => {
    const terminalStates = [
      ["timed_out", "timed out"],
      ["cancelled", "cancelled"],
    ] satisfies readonly (readonly [string, string])[];

    for (const [status, label] of terminalStates) {
      const presentation = presentBrowserToolPart(
        browserPart({
          input: {},
          output: {
            action: {
              action: "browser_click",
              evidence: { status },
              ok: true,
              tabId: 4,
              url: "https://example.test/",
            },
            observation: null,
            observationError: null,
          },
          state: "output-available",
          toolCallId: `call-${status}`,
          toolName: "browser_click",
          type: "dynamic-tool",
        }),
      );

      expect(presentation?.label).toBe(label);
    }
  });

  test("uses typed recovery guidance and never includes page payloads", () => {
    const presentation = presentBrowserToolPart(
      browserPart({
        input: { dom: "input-dom", target: { ref: 4 }, screenshot: "input-image" },
        output: {
          action: {
            action: "browser_click",
            error: { code: "stale_ref" },
            ok: false,
          },
          observation: {
            dom: "secret semantic dom",
            screenshot: { data: "base64-secret" },
          },
          observationError: { code: "observation_failed" },
        },
        state: "output-available",
        toolCallId: "call-stale",
        toolName: "browser_click",
        type: "dynamic-tool",
      }),
    );

    expect(presentation?.label).toBe("failed");
    expect(presentation?.input).not.toHaveProperty("dom");
    expect(presentation?.input).not.toHaveProperty("screenshot");
    expect(presentation?.output).toContain("Observe it again");
    expect(presentation?.output).toContain("could not refresh the page");
    expect(presentation?.output).not.toContain("secret semantic dom");
    expect(presentation?.output).not.toContain("base64-secret");
  });

  test("keeps Eve error text and adds recovery for uncertain replays", () => {
    const presentation = presentBrowserToolPart(
      browserPart({
        errorText: "browser_observe failed (action_replay_uncertain): request outcome is unknown",
        input: {},
        state: "output-error",
        toolCallId: "call-uncertain",
        toolName: "browser_click",
        type: "dynamic-tool",
      }),
    );

    expect(presentation?.label).toBe("failed");
    expect(presentation?.errorText).toContain("request outcome is unknown");
    expect(presentation?.errorText).toContain("Observe the page before trying it again");
  });

  test("keeps unrecognized dynamic tools out of browser rows", () => {
    expect(
      presentBrowserToolPart(
        browserPart({
          input: {},
          state: "input-available",
          toolCallId: "call-other",
          toolName: "not_a_browser_tool",
          type: "dynamic-tool",
        }),
      ),
    ).toBeNull();
  });
});
