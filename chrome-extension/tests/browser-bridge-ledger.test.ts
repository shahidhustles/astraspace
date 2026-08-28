import { beforeEach, describe, expect, test } from "bun:test";
import type { BrowserWorkResult } from "@astra-space/browser-control-contract";
import { BrowserMutationLedger } from "../src/browser/bridge-ledger";

let store = new Map<string, unknown>();

beforeEach(() => {
  store = new Map();
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (record: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(record)) store.set(key, value);
        },
      },
    },
  } as typeof chrome;
});

function result(requestId: string): BrowserWorkResult {
  return {
    requestId,
    sessionId: "session-1",
    status: "completed",
    payload: { ok: true },
    completedAt: new Date().toISOString(),
  };
}

describe("BrowserMutationLedger", () => {
  test("marks before dispatch and reports an interrupted replay as uncertain", async () => {
    const first = new BrowserMutationLedger();
    expect(await first.begin("call-1")).toBe("dispatch");
    const restarted = new BrowserMutationLedger();
    expect(await restarted.begin("call-1")).toBe("uncertain");
  });

  test("returns a terminal result without dispatching again", async () => {
    const ledger = new BrowserMutationLedger();
    expect(await ledger.begin("call-1")).toBe("dispatch");
    const terminal = result("request-1");
    await ledger.settle("call-1", terminal);
    expect(await new BrowserMutationLedger().begin("call-1")).toEqual(terminal);
  });

  test("serializes concurrent claims for the same action id", async () => {
    const ledger = new BrowserMutationLedger();
    const claims = await Promise.all([ledger.begin("call-1"), ledger.begin("call-1")]);
    expect(claims.filter((claim) => claim === "dispatch")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "uncertain")).toHaveLength(1);
  });
});
