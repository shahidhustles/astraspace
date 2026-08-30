import { describe, expect, test } from "bun:test";

import { readTextMessage } from "../extension/lib/messages";

describe("readTextMessage", () => {
  test("reads a plain WhatsApp text message", () => {
    expect(readTextMessage({ conversation: "  open example.com  " })).toBe("open example.com");
  });

  test("reads an extended text message", () => {
    expect(readTextMessage({ extendedTextMessage: { text: "click Sign in" } })).toBe(
      "click Sign in",
    );
  });

  test("ignores media and empty text", () => {
    expect(readTextMessage({ imageMessage: { url: "https://example.com/image.jpg" } })).toBeNull();
    expect(readTextMessage({ conversation: "   " })).toBeNull();
  });
});
