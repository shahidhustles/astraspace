import { describe, expect, test } from "bun:test";
import { ChatMessage } from "../src/components/chat-message";
import { Loader } from "../src/components/ai-elements/loader";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../src/components/ai-elements/reasoning";
import type { EveMessage } from "eve/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

describe("chat message rendering", () => {
  test("preserves the order of Eve text and reasoning parts", () => {
    const message = {
      id: "message-1",
      parts: [
        { state: "done", text: "reasoning-first", type: "reasoning" },
        { state: "done", text: "answer-second", type: "text" },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const html = renderToStaticMarkup(createElement(ChatMessage, { message }));

    expect(html.indexOf("reasoning-first")).toBeLessThan(html.indexOf("answer-second"));
  });

  test("preserves browser tools between Eve text parts", () => {
    const message = {
      id: "message-2",
      parts: [
        { state: "done", text: "before-tool", type: "text" },
        {
          input: {},
          output: {
            observation: {
              dom: "never-render-this-dom",
              refs: [],
              screenshot: { data: "never-render-this-base64" },
              snapshot: { snapshotId: "snapshot-1" },
              tabId: 7,
              title: "Example page",
              url: "https://example.test/",
            },
          },
          state: "output-available",
          toolCallId: "call-1",
          toolName: "browser_observe",
          type: "dynamic-tool",
        },
        { state: "done", text: "after-tool", type: "text" },
      ],
      role: "assistant",
    } satisfies EveMessage;

    const html = renderToStaticMarkup(createElement(ChatMessage, { message }));

    expect(html.indexOf("before-tool")).toBeLessThan(html.indexOf("Observe page"));
    expect(html.indexOf("Observe page")).toBeLessThan(html.indexOf("after-tool"));
    expect(html).not.toContain("never-render-this-dom");
    expect(html).not.toContain("never-render-this-base64");
  });

  test("does not render closed reasoning content", () => {
    const html = renderToStaticMarkup(
      createElement(
        Reasoning,
        { open: false },
        createElement(ReasoningTrigger),
        createElement(ReasoningContent, null, "hidden-reasoning"),
      ),
    );

    expect(html).not.toContain("hidden-reasoning");
  });
});

describe("reply loader", () => {
  test("renders the Prompt Kit bars variant with an accessible status", () => {
    const html = renderToStaticMarkup(
      createElement(Loader, { size: "sm", variant: "bars" }),
    );

    expect(html.match(/wave-bars/g)).toHaveLength(3);
    expect(html).toContain("Eve is responding");
  });
});
