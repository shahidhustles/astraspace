import {
  BROWSER_CONTROL_BIND_PATH,
  BROWSER_CONTROL_CONNECTION_HEADER,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_REQUESTS_PATH,
  BROWSER_CONTROL_RESULTS_PATH,
  MAX_LONG_POLL_MS,
  type BrowserBindResult,
  type BrowserControlBody,
  type BrowserLeaseResult,
  type BrowserWorkRequest,
  type BrowserWorkResult,
  isBrowserControlBody,
  isBrowserWorkRequest,
  isBrowserWorkResult,
} from "@astra-space/browser-control-contract";
import { EVE_HOST } from "@/lib/eve-config";
import {
  clearBrowserConnection,
  readStoredBrowserConnection,
  storeBrowserConnection,
  type StoredBrowserConnection,
} from "@/lib/eve-browser-session";

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export type BrowserRequestDispatcher = (request: BrowserWorkRequest) => Promise<BrowserWorkResult>;

class BrokerRejection extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function isLeaseData(value: unknown): value is BrowserLeaseResult {
  if (typeof value !== "object" || value === null) return false;
  const requests = (value as { requests?: unknown }).requests;
  return Array.isArray(requests) && requests.every(isBrowserWorkRequest);
}

function isBindData(value: unknown): value is BrowserBindResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === "string" &&
    typeof (value as { connectionToken?: unknown }).connectionToken === "string" &&
    typeof (value as { generation?: unknown }).generation === "number"
  );
}

function failedResult(
  request: BrowserWorkRequest,
  code: "broker_unavailable",
  message: string,
): BrowserWorkResult {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    status: "failed",
    error: { code, message },
    completedAt: new Date().toISOString(),
  };
}

async function parseEnvelope<TData>(
  response: Response,
  isData: (data: unknown) => data is TData,
): Promise<BrowserControlBody<TData>> {
  const body: unknown = await response.json().catch(() => null);
  if (!isBrowserControlBody<TData>(body, isData)) {
    throw new BrokerRejection("malformed_envelope", "Browser-control response was not a valid envelope");
  }
  return body;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class BrowserControlBridge {
  private readonly host: string;
  private dispatcher: BrowserRequestDispatcher | null = null;
  private connection: StoredBrowserConnection | null = null;
  private loopEpoch = 0;
  private pollController: AbortController | null = null;
  private loopTask: Promise<void> | null = null;

  constructor(host: string = EVE_HOST) {
    this.host = host;
  }

  get activeSessionId(): string | null {
    return this.loopTask !== null ? (this.connection?.sessionId ?? null) : null;
  }

  setDispatcher(dispatcher: BrowserRequestDispatcher): void {
    this.dispatcher = dispatcher;
  }

  async bind(sessionId: string): Promise<boolean> {
    if (this.activeSessionId === sessionId) return true;

    let envelope: BrowserControlBody<BrowserBindResult>;
    try {
      const response = await fetch(`${this.host}${BROWSER_CONTROL_BIND_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }),
      });
      envelope = await parseEnvelope(response, isBindData);
    } catch (error) {
      console.info("browser-bridge bind failed", error);
      return false;
    }

    if (!envelope.ok) {
      console.info("browser-bridge bind rejected", envelope.error.code);
      return false;
    }

    const connection: StoredBrowserConnection = {
      sessionId,
      connectionToken: envelope.data.connectionToken,
      generation: envelope.data.generation,
    };
    await storeBrowserConnection(connection);
    this.startLoop(connection);
    return true;
  }

  async resumeFromStorage(): Promise<boolean> {
    const stored = await readStoredBrowserConnection();
    if (stored === null) return false;
    this.startLoop(stored);
    return true;
  }

  async stop(): Promise<void> {
    this.connection = null;
    this.loopEpoch += 1;
    this.pollController?.abort();
    this.pollController = null;
    const task = this.loopTask;
    this.loopTask = null;
    await task?.catch(() => {});
  }

  private startLoop(connection: StoredBrowserConnection): void {
    this.loopEpoch += 1;
    this.pollController?.abort();
    const epoch = this.loopEpoch;
    this.connection = connection;
    this.loopTask = this.pollLoop(connection, epoch).finally(() => {
      if (this.loopEpoch === epoch) this.loopTask = null;
    });
  }

  private isLive(connection: StoredBrowserConnection, epoch: number): boolean {
    return this.connection === connection && this.loopEpoch === epoch;
  }

  private async pollLoop(connection: StoredBrowserConnection, epoch: number): Promise<void> {
    let backoffMs = MIN_BACKOFF_MS;
    while (this.isLive(connection, epoch)) {
      try {
        const lease = await this.leaseOnce(connection);
        if (!this.isLive(connection, epoch)) return;
        for (const request of lease.requests) {
          await this.processRequest(connection, request);
          if (!this.isLive(connection, epoch)) return;
        }
        backoffMs = MIN_BACKOFF_MS;
      } catch (error) {
        if (error instanceof BrokerRejection && error.code === "invalid_token") {
          this.connection = null;
          await clearBrowserConnection().catch(() => {});
          return;
        }
        if (!this.isLive(connection, epoch)) return;
        console.info("browser-bridge lease cycle failed", error);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async leaseOnce(connection: StoredBrowserConnection): Promise<BrowserLeaseResult> {
    const controller = new AbortController();
    this.pollController = controller;
    try {
      const response = await fetch(
        `${this.host}${BROWSER_CONTROL_REQUESTS_PATH}?waitMs=${MAX_LONG_POLL_MS}`,
        {
          headers: { [BROWSER_CONTROL_CONNECTION_HEADER]: connection.connectionToken },
          signal: controller.signal,
        },
      );
      const envelope = await parseEnvelope(response, isLeaseData);
      if (!envelope.ok) throw new BrokerRejection(envelope.error.code, envelope.error.message);
      return envelope.data;
    } finally {
      if (this.pollController === controller) this.pollController = null;
    }
  }

  private async processRequest(
    connection: StoredBrowserConnection,
    request: BrowserWorkRequest,
  ): Promise<void> {
    let result: BrowserWorkResult | null = null;
    if (this.dispatcher !== null) {
      try {
        result = await this.dispatcher(request);
      } catch (error) {
        console.info("browser-bridge dispatcher failed", error);
      }
    }

    const valid =
      result !== null &&
      result.requestId === request.requestId &&
      result.sessionId === request.sessionId &&
      isBrowserWorkResult(result);
    if (!valid) {
      result = failedResult(
        request,
        "broker_unavailable",
        "The service worker returned no valid browser result",
      );
    }

    const response = await fetch(`${this.host}${BROWSER_CONTROL_RESULTS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BROWSER_CONTROL_CONNECTION_HEADER]: connection.connectionToken,
      },
      body: JSON.stringify(result),
    });
    const envelope = await parseEnvelope(response, isResultAcknowledgement);
    if (!envelope.ok) throw new BrokerRejection(envelope.error.code, envelope.error.message);
  }
}

function isResultAcknowledgement(value: unknown): value is { requestId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { requestId?: unknown }).requestId === "string"
  );
}
