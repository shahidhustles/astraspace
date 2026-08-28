import { isBrowserWorkResult, type BrowserWorkResult } from "@astra-space/browser-control-contract";

const LEDGER_KEY = "astra.browser.mutation-ledger";
const MAX_ENTRIES = 32;

type LedgerEntry =
  | { state: "dispatched"; updatedAt: number }
  | { state: "settled"; updatedAt: number; result: BrowserWorkResult };

type Ledger = Record<string, LedgerEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isRecord(value) || typeof value.updatedAt !== "number") return false;
  if (value.state === "dispatched") return true;
  return value.state === "settled" && isBrowserWorkResult(value.result);
}

export class BrowserMutationLedger {
  private tail: Promise<void> = Promise.resolve();

  async begin(actionId: string): Promise<"dispatch" | "uncertain" | BrowserWorkResult> {
    return this.lock(async () => {
      const ledger = await this.read();
      const existing = ledger[actionId];
      if (existing?.state === "settled") return existing.result;
      if (existing?.state === "dispatched") return "uncertain";
      ledger[actionId] = { state: "dispatched", updatedAt: Date.now() };
      await this.write(ledger);
      return "dispatch";
    });
  }

  async settle(actionId: string, result: BrowserWorkResult): Promise<void> {
    await this.lock(async () => {
      const ledger = await this.read();
      ledger[actionId] = { state: "settled", updatedAt: Date.now(), result };
      await this.write(ledger);
    });
  }

  private async lock<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async read(): Promise<Ledger> {
    const stored = await chrome.storage.session.get(LEDGER_KEY);
    const value: unknown = stored[LEDGER_KEY];
    if (!isRecord(value)) return {};
    const ledger: Ledger = {};
    for (const [actionId, entry] of Object.entries(value)) {
      if (isLedgerEntry(entry)) ledger[actionId] = entry;
    }
    return ledger;
  }

  private async write(ledger: Ledger): Promise<void> {
    const bounded = Object.fromEntries(
      Object.entries(ledger)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, MAX_ENTRIES),
    );
    await chrome.storage.session.set({ [LEDGER_KEY]: bounded });
  }
}
