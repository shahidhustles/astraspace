import { isBrowserWorkResult, type BrowserWorkResult } from "@astra-space/browser-control-contract";

const LEDGER_KEY = "astra.browser.mutation-ledger";
const MAX_ENTRIES = 32;
const RETIRED_WORDS = 64;
const RETIRED_BITS = RETIRED_WORDS * 32;

type LedgerEntry =
  | { state: "dispatched"; updatedAt: number }
  | { state: "settled"; updatedAt: number; result: BrowserWorkResult };

type Ledger = Record<string, LedgerEntry>;

interface LedgerState {
  entries: Ledger;
  retired: number[];
}

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
      const state = await this.read();
      const existing = state.entries[actionId];
      if (existing?.state === "settled") return existing.result;
      if (existing?.state === "dispatched") return "uncertain";
      if (wasRetired(state.retired, actionId)) return "uncertain";
      if (
        Object.keys(state.entries).length >= MAX_ENTRIES &&
        !Object.values(state.entries).some((entry) => entry.state === "settled")
      ) {
        return "uncertain";
      }
      state.entries[actionId] = { state: "dispatched", updatedAt: Date.now() };
      await this.write(state);
      return "dispatch";
    });
  }

  async settle(actionId: string, result: BrowserWorkResult): Promise<void> {
    await this.lock(async () => {
      const state = await this.read();
      state.entries[actionId] = { state: "settled", updatedAt: Date.now(), result };
      await this.write(state);
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

  private async read(): Promise<LedgerState> {
    const stored = await chrome.storage.session.get(LEDGER_KEY);
    const value: unknown = stored[LEDGER_KEY];
    if (!isRecord(value)) return emptyLedgerState();
    const storedEntries = isRecord(value.entries) ? value.entries : value;
    const ledger: Ledger = {};
    for (const [actionId, entry] of Object.entries(storedEntries)) {
      if (isLedgerEntry(entry)) ledger[actionId] = entry;
    }
    const retired = Array.isArray(value.retired)
      ? value.retired.slice(0, RETIRED_WORDS).map((word) =>
          typeof word === "number" && Number.isInteger(word) ? word >>> 0 : 0,
        )
      : [];
    while (retired.length < RETIRED_WORDS) retired.push(0);
    return { entries: ledger, retired };
  }

  private async write(state: LedgerState): Promise<void> {
    const settledOldestFirst = Object.entries(state.entries)
      .filter((entry): entry is [string, Extract<LedgerEntry, { state: "settled" }>] => entry[1].state === "settled")
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt);
    while (Object.keys(state.entries).length > MAX_ENTRIES) {
      const retired = settledOldestFirst.shift();
      if (retired === undefined) break;
      delete state.entries[retired[0]];
      markRetired(state.retired, retired[0]);
    }
    await chrome.storage.session.set({
      [LEDGER_KEY]: { entries: state.entries, retired: state.retired },
    });
  }
}

function emptyLedgerState(): LedgerState {
  return { entries: {}, retired: Array.from({ length: RETIRED_WORDS }, () => 0) };
}

function retiredIndexes(actionId: string): readonly [number, number, number] {
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < actionId.length; index += 1) {
    const code = actionId.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  const third = Math.imul(first ^ (second >>> 16), 2246822519) >>> 0;
  return [first % RETIRED_BITS, second % RETIRED_BITS, third % RETIRED_BITS];
}

function markRetired(words: number[], actionId: string): void {
  for (const index of retiredIndexes(actionId)) {
    const word = Math.floor(index / 32);
    words[word] = ((words[word] ?? 0) | (1 << (index % 32))) >>> 0;
  }
}

function wasRetired(words: number[], actionId: string): boolean {
  return retiredIndexes(actionId).every((index) => {
    const word = words[Math.floor(index / 32)] ?? 0;
    return (word & (1 << (index % 32))) !== 0;
  });
}
