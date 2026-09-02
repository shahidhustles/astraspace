import { describe, expect, test } from "bun:test";

import { isWhatsAppEnabled } from "../extension/lib/runtime-config";

describe("isWhatsAppEnabled", () => {
  test("disables WhatsApp when the switch is unset", () => {
    expect(isWhatsAppEnabled(undefined)).toBe(false);
  });

  test("disables WhatsApp for values other than 1", () => {
    expect(isWhatsAppEnabled("0")).toBe(false);
    expect(isWhatsAppEnabled("true")).toBe(false);
  });

  test("enables WhatsApp only for 1", () => {
    expect(isWhatsAppEnabled("1")).toBe(true);
  });
});
