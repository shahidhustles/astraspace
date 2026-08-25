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
