import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  type BrowserBindResult,
  type BrowserControlErrorCode,
  type BrowserLeaseResult,
  type BrowserWorkRequest,
  type BrowserWorkResult,
  isBrowserWorkRequest,
  isBrowserWorkResult,
  jsonByteSize,
} from "@astra-space/browser-control-contract";

export type EnqueueBrowserWorkInput = {
  sessionId: string;
  turnId: string;
  callId: string;
  kind: string;
  payload: Record<string, unknown>;
};

export class BrowserBrokerError extends Error {
  readonly code: BrowserControlErrorCode;

  constructor(code: BrowserControlErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface ConnectionRecord {
  sessionId: string;
  connectionToken: string;
  generation: number;
  boundAt: string;
}

interface LeaseMarker {
  leaseUntil: number;
}

interface BrokerTimings {
  leaseMs: number;
  resultRetentionMs: number;
  pendingMaxAgeMs: number;
  sweepIntervalMs: number;
  staleInstanceMs: number;
  pollIntervalMs: number;
}

const DEFAULT_TIMINGS: BrokerTimings = {
  leaseMs: 30_000,
  resultRetentionMs: 60_000,
  pendingMaxAgeMs: 10 * 60_000,
  sweepIntervalMs: 5_000,
  staleInstanceMs: 24 * 60 * 60_000,
  pollIntervalMs: 50,
};

const MAX_SWEEP_OPS = 500;

export interface BrowserBrokerOptions {
  root?: string;
  now?: () => number;
  timings?: Partial<BrokerTimings>;
  sweep?: boolean;
}

const SHARED_KEY = Symbol.for("astra.browser-broker");

export class BrowserBroker {
  readonly instanceId: string;

  private readonly root: string;
  private readonly ownsRoot: boolean;
  private readonly now: () => number;
  private readonly timings: BrokerTimings;
  private readonly sweepEnabled: boolean;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private staleSweepDone = false;
  private generation = 0;

  constructor(options: BrowserBrokerOptions = {}) {
    this.ownsRoot = options.root === undefined;
    this.root =
      options.root ?? join(tmpdir(), "astra-browser-control", `${Date.now()}-${randomUUID()}`);
    this.now = options.now ?? Date.now;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.sweepEnabled = options.sweep ?? true;
    this.instanceId = this.root.split("/").pop() ?? this.root;
  }

  static shared(): BrowserBroker {
    const host = globalThis as typeof globalThis & { [SHARED_KEY]?: BrowserBroker };
    if (!host[SHARED_KEY]) {
      host[SHARED_KEY] = new BrowserBroker();
    }
    return host[SHARED_KEY];
  }

  private pendingDir(): string {
    return join(this.root, "pending");
  }

  private leasedDir(): string {
    return join(this.root, "leases");
  }

  private resultsDir(): string {
    return join(this.root, "results");
  }

  private connectionFile(): string {
    return join(this.root, "connections", "active.json");
  }

  private requestFile(requestId: string): string {
    return join(this.pendingDir(), `${requestId}.json`);
  }

  private leaseFile(requestId: string): string {
    return join(this.leasedDir(), `${requestId}.json`);
  }

  private resultFile(requestId: string): string {
    return join(this.resultsDir(), `${requestId}.json`);
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.pendingDir(), { recursive: true });
    await mkdir(this.leasedDir(), { recursive: true });
    await mkdir(this.resultsDir(), { recursive: true });
    await mkdir(join(this.root, "connections"), { recursive: true });
    if (this.sweepEnabled) {
      if (!this.staleSweepDone) {
        this.staleSweepDone = true;
        void this.sweepStaleInstances().catch(() => {});
      }
      if (this.sweepTimer === null) {
        this.sweepTimer = setInterval(() => {
          void this.sweep().catch(() => {});
        }, this.timings.sweepIntervalMs);
        this.sweepTimer.unref?.();
      }
    }
  }

  async bind(sessionId: string): Promise<BrowserBindResult> {
    if (sessionId.length === 0) {
      throw new BrowserBrokerError("malformed_envelope", "sessionId is required");
    }
    await this.ensureDirs();
    this.generation += 1;
    const record: ConnectionRecord = {
      sessionId,
      connectionToken: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      generation: this.generation,
      boundAt: new Date(this.now()).toISOString(),
    };
    await writeFile(this.connectionFile(), JSON.stringify(record), "utf8");
    return {
      sessionId: record.sessionId,
      connectionToken: record.connectionToken,
      generation: record.generation,
    };
  }

  private async readConnection(token: string): Promise<ConnectionRecord> {
    const raw = await readFile(this.connectionFile(), "utf8").catch(() => null);
    let parsed: ConnectionRecord | null = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw) as ConnectionRecord;
      } catch {
        parsed = null;
      }
    }
    if (!parsed || typeof parsed.connectionToken !== "string" || parsed.connectionToken !== token) {
      throw new BrowserBrokerError("invalid_token", "Connection token is not active");
    }
    return parsed;
  }

  async enqueue(sessionId: string, input: EnqueueBrowserWorkInput): Promise<BrowserWorkRequest> {
    if (input.sessionId !== sessionId) {
      throw new BrowserBrokerError("invalid_session", "Request targets a different session");
    }
    if (
      input.turnId.length === 0 ||
      input.callId.length === 0 ||
      input.kind.length === 0 ||
      typeof input.payload !== "object" ||
      input.payload === null
    ) {
      throw new BrowserBrokerError("malformed_envelope", "Request fields are incomplete");
    }
    const request: BrowserWorkRequest = {
      requestId: randomUUID(),
      sessionId,
      turnId: input.turnId,
      callId: input.callId,
      kind: input.kind,
      payload: input.payload,
      createdAt: new Date(this.now()).toISOString(),
    };
    const size = jsonByteSize(request);
    if (size === null) {
      throw new BrowserBrokerError("malformed_envelope", "Request payload is not JSON-safe");
    }
    if (size > MAX_REQUEST_BYTES) {
      throw new BrowserBrokerError("payload_too_large", "Request exceeds the request size bound");
    }
    await this.ensureDirs();
    await writeFile(this.requestFile(request.requestId), JSON.stringify(request), "utf8");
    return request;
  }

  async lease(connectionToken: string, waitMs: number): Promise<BrowserLeaseResult> {
    const connection = await this.readConnection(connectionToken);
    await this.ensureDirs();
    const deadline = this.now() + Math.max(0, waitMs);

    while (true) {
      const request = await this.claimOne(connection.sessionId);
      if (request) return { requests: [request] };
      if (this.now() >= deadline) return { requests: [] };
      await sleep(this.timings.pollIntervalMs);
    }
  }

  private async claimOne(sessionId: string): Promise<BrowserWorkRequest | null> {
    const entries = await readdir(this.pendingDir()).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const requestId = entry.slice(0, -".json".length);
      if (await this.exists(this.resultFile(requestId))) continue;
      const claimed = await this.claimLease(requestId);
      if (!claimed) continue;
      const request = await this.readJson<BrowserWorkRequest>(this.requestFile(requestId));
      if (request === null || request.sessionId !== sessionId || !isBrowserWorkRequest(request)) {
        await this.settleFailed(requestId, sessionId, "invalid_session", "Claimed request is not valid");
        continue;
      }
      return request;
    }
    return null;
  }

  private async claimLease(requestId: string): Promise<boolean> {
    const marker: LeaseMarker = { leaseUntil: this.now() + this.timings.leaseMs };
    try {
      const handle = await open(this.leaseFile(requestId), "wx");
      try {
        await handle.writeFile(JSON.stringify(marker), "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async submitResult(connectionToken: string, result: BrowserWorkResult): Promise<void> {
    const connection = await this.readConnection(connectionToken);
    if (result.sessionId !== connection.sessionId) {
      throw new BrowserBrokerError("invalid_session", "Result targets a different session");
    }
    if (!isBrowserWorkResult(result)) {
      throw new BrowserBrokerError("malformed_envelope", "Result envelope is not valid");
    }
    const size = jsonByteSize(result);
    if (size === null) {
      throw new BrowserBrokerError("malformed_envelope", "Result payload is not JSON-safe");
    }
    if (size > MAX_RESULT_BYTES) {
      throw new BrowserBrokerError("payload_too_large", "Result exceeds the result size bound");
    }
    if (!(await this.exists(this.requestFile(result.requestId)))) {
      if (await this.exists(this.resultFile(result.requestId))) return;
      throw new BrowserBrokerError("unknown_request", "No matching pending request");
    }
    const settled = await this.settleResult(result);
    if (!settled) return;
    await this.unlinkQuietly(this.requestFile(result.requestId));
    await this.unlinkQuietly(this.leaseFile(result.requestId));
  }

  async cancel(sessionId: string, requestId: string): Promise<boolean> {
    const pending = await this.readJson<BrowserWorkRequest>(this.requestFile(requestId));
    if (pending === null || pending.sessionId !== sessionId) return false;
    const cancelled: BrowserWorkResult = {
      requestId,
      sessionId,
      status: "cancelled",
      completedAt: new Date(this.now()).toISOString(),
    };
    const settled = await this.settleResult(cancelled);
    if (settled) {
      await this.unlinkQuietly(this.requestFile(requestId));
      await this.unlinkQuietly(this.leaseFile(requestId));
    }
    return settled;
  }

  async waitForResult(
    sessionId: string,
    requestId: string,
    timeoutMs: number,
  ): Promise<BrowserWorkResult> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    while (true) {
      const result = await this.readJson<BrowserWorkResult>(this.resultFile(requestId));
      if (result !== null && isBrowserWorkResult(result) && result.sessionId === sessionId) {
        return result;
      }
      if (this.now() >= deadline) {
        await this.cancel(sessionId, requestId);
        throw new BrowserBrokerError(
          "lease_expired",
          "No browser-control result arrived before the wait deadline",
        );
      }
      await sleep(this.timings.pollIntervalMs);
    }
  }

  private async settleResult(result: BrowserWorkResult): Promise<boolean> {
    try {
      const handle = await open(this.resultFile(result.requestId), "wx");
      try {
        await handle.writeFile(JSON.stringify(result), "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private async settleFailed(
    requestId: string,
    sessionId: string,
    code: BrowserControlErrorCode,
    message: string,
  ): Promise<void> {
    const failed: BrowserWorkResult = {
      requestId,
      sessionId,
      status: "failed",
      error: { code, message },
      completedAt: new Date(this.now()).toISOString(),
    };
    if (await this.settleResult(failed)) {
      await this.unlinkQuietly(this.requestFile(requestId));
      await this.unlinkQuietly(this.leaseFile(requestId));
    }
  }

  async sweep(): Promise<number> {
    const nowMs = this.now();
    let ops = 0;

    const pendingEntries = await readdir(this.pendingDir()).catch(() => []);
    for (const entry of pendingEntries) {
      if (ops >= MAX_SWEEP_OPS) break;
      if (!entry.endsWith(".json")) continue;
      const requestId = entry.slice(0, -".json".length);
      const record = await this.readJson<BrowserWorkRequest>(this.requestFile(requestId));
      if (record === null) {
        await this.unlinkQuietly(this.requestFile(requestId));
        ops += 1;
        continue;
      }
      const age = nowMs - Date.parse(record.createdAt);
      if (!Number.isFinite(age) || age > this.timings.pendingMaxAgeMs) {
        await this.settleFailed(
          requestId,
          record.sessionId ?? "unknown",
          "lease_expired",
          "No extension leased the request before the pending deadline",
        );
        ops += 1;
        continue;
      }
      if (await this.exists(this.resultFile(requestId))) {
        await this.unlinkQuietly(this.requestFile(requestId));
        ops += 1;
      }
    }

    const leaseEntries = await readdir(this.leasedDir()).catch(() => []);
    for (const entry of leaseEntries) {
      if (ops >= MAX_SWEEP_OPS) break;
      if (!entry.endsWith(".json")) continue;
      const requestId = entry.slice(0, -".json".length);
      const marker = await this.readJson<LeaseMarker>(this.leaseFile(requestId));
      if (marker === null || !Number.isFinite(marker.leaseUntil) || marker.leaseUntil < nowMs) {
        await this.unlinkQuietly(this.leaseFile(requestId));
        ops += 1;
      }
    }

    const resultEntries = await readdir(this.resultsDir()).catch(() => []);
    for (const entry of resultEntries) {
      if (ops >= MAX_SWEEP_OPS) break;
      if (!entry.endsWith(".json")) continue;
      const requestId = entry.slice(0, -".json".length);
      const record = await this.readJson<BrowserWorkResult>(this.resultFile(requestId));
      if (record === null) {
        await this.unlinkQuietly(this.resultFile(requestId));
        ops += 1;
        continue;
      }
      const age = nowMs - Date.parse(record.completedAt);
      if (!Number.isFinite(age) || age > this.timings.resultRetentionMs) {
        await this.unlinkQuietly(this.resultFile(requestId));
        ops += 1;
      }
    }

    return ops;
  }

  async sweepStaleInstances(): Promise<number> {
    const parent = this.root.slice(0, this.root.lastIndexOf("/"));
    const entries = await readdir(parent).catch(() => []);
    const nowMs = this.now();
    let removed = 0;
    for (const entry of entries) {
      if (entry === this.instanceId) continue;
      const candidate = join(parent, entry);
      const info = await stat(candidate).catch(() => null);
      if (info === null || !info.isDirectory()) continue;
      if (nowMs - info.mtimeMs > this.timings.staleInstanceMs) {
        await rm(candidate, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.ownsRoot) {
      await rm(this.root, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async readJson<T>(file: string): Promise<T | null> {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async exists(file: string): Promise<boolean> {
    return (await stat(file).catch(() => null)) !== null;
  }

  private async unlinkQuietly(file: string): Promise<void> {
    await rm(file, { force: true }).catch(() => {});
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function createBrokerRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
