import { describe, expect, test } from "bun:test";
import { calculateUsedTokens } from "../src/lib/eve-runtime-metadata";

describe("calculateUsedTokens", () => {
  test("counts input and output without double-counting cache details", () => {
    expect(
      calculateUsedTokens({
        cacheReadTokens: 120,
        cacheWriteTokens: 5_859,
        inputTokens: 5_902,
        outputTokens: 8,
      }),
    ).toBe(5_910);
  });

  test("does not claim measured usage from cache details alone", () => {
    expect(calculateUsedTokens({ cacheReadTokens: 120 })).toBeUndefined();
  });
});
