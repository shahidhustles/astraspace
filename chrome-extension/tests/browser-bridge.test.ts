import { afterEach, describe, expect, test } from "bun:test";
import {
  BROWSER_CONTROL_BIND_PATH,
  BROWSER_CONTROL_CONNECTION_HEADER,
  BROWSER_CONTROL_REQUESTS_PATH,
  BROWSER_CONTROL_RESULTS_PATH,
  type BrowserBindResult,
  type BrowserWorkRequest,
  type BrowserWorkResult,
  browserControlFailure,
} from "@astra-space/browser-control-contract";
import { BrowserControlBridge } from "../src/browser/bridge";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

const LEASE_TOKEN_HEADER = BROWSER_CONTROL_CONNECTION_HEADER;

type SessionStore = Map<string, unknown>;

interface ChromeStub {
  store: SessionStore;
  sentMessages: unknown[];
  install: () => void;
}

function installChromeStub(): ChromeStub {
  const store: SessionStore = new Map();
  const sentMessages: unknown[] = [];
  const stub = {
    store,
    sentMessages,
    install() {
      (globalThis as { chrome?: unknown }).chrome = {
        storage: {
          session: {
            get: async (keys: unknown) => {
              const names = Array.isArray(keys)
                ? (keys as string[])
                : typeof keys === "string"
                  ? [keys]
                  : Object.keys(keys ?? {});
              const found: Record<string, unknown> = {};
              for (const name of names) {
                const value = store.get(name);
                if (value !== undefined) found[name] = value;
              }
              return found;
            },
            set: async (keys: unknown) => {
              for (const [name, value] of entriesOf(keys)) store.set(name, value);
            },
            remove: async (keys: unknown) => {
              for (const name of Array.isArray(keys) ? (keys as string[]) : [String(keys)]) {
                store.delete(name);
              }
            },
          },
        },
        runtime: {
          sendMessage: async (message: unknown) => {
            sentMessages.push(message);
          },
        },
      };
    },
  };
  stub.install();
  return stub;
}

function entriesOf(keys: unknown): Array<[string, unknown]> {
  return Object.entries(keys as Record<string, unknown>);
}

interface FakeLeaseCall {
  token: string | null;
}

class FakeBroker {
  connection: BrowserBindResult | null = null;
  queued: BrowserWorkRequest[] = [];
  results = new Map<string, BrowserWorkResult>();
  leaseCalls: FakeLeaseCall[] = [];
  bindCount = 0;
  failLeaseWithInvalidToken = false;
  private waiters: Array<(request: BrowserWorkRequest) => void> = [];

  readonly maxHoldMs = 200;

  enqueue(sessionId: string, overrides: Partial<BrowserWorkRequest> = {}): BrowserWorkRequest {
    const request: BrowserWorkRequest = {
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      sessionId,
      turnId: "turn_1",
      callId: `call_${this.queued.length + 1}`,
      kind: "browser.observe",
      payload: { url: "https://example.test" },
      createdAt: new Date().toISOString(),
      ...overrides,
    };
    this.queued.push(request);
    const waiter = this.waiters.shift();
    if (waiter) waiter(request);
    return request;
  }

  handle(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === BROWSER_CONTROL_BIND_PATH) {
      return this.handleBind(request);
    }
    if (url.pathname === BROWSER_CONTROL_REQUESTS_PATH) {
      return this.handleRequests(request);
    }
    if (url.pathname === BROWSER_CONTROL_RESULTS_PATH) {
      return this.handleResults(request);
    }
    return new Response("not found", { status: 404 });
  }

  private handleBind(request: Request): Response {
    this.bindCount += 1;
    void request;
    const connection: BrowserBindResult = {
      sessionId: "ses_current",
      connectionToken: `token-${this.bindCount}`,
      generation: this.bindCount,
    };
    this.connection = connection;
    return Response.json({ ok: true, data: connection });
  }

  private handleRequests(request: Request): Response {
    const token = request.headers.get(LEASE_TOKEN_HEADER);
    this.leaseCalls.push({ token });
    if (this.failLeaseWithInvalidToken) {
      return Response.json(
        browserControlFailure({ code: "invalid_token", message: "token is stale" }),
      );
    }
    const queuedNow = this.queued.shift();
    if (queuedNow) {
      return Response.json({ ok: true, data: { requests: [queuedNow] } });
    }
    const waitMs = Number(new URL(request.url).searchParams.get("waitMs") ?? "0");
    const holdMs = Math.min(Number.isFinite(waitMs) ? waitMs : 0, this.maxHoldMs);
    const waited = new Promise<BrowserWorkRequest | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), holdMs);
      this.waiters.push((request_) => {
        clearTimeout(timer);
        resolve(request_);
      });
    });
    return waited.then((late) =>
      Response.json({ ok: true, data: { requests: late === null ? [] : [late] } }),
    );
  }

  private handleResults(request: Request): Response {
    const token = request.headers.get(LEASE_TOKEN_HEADER);
    if (token !== this.connection?.connectionToken) {
      return Response.json(
        browserControlFailure({ code: "invalid_token", message: "token is stale" }),
      );
    }
    return request.json().then((body) => {
      const result = body as BrowserWorkResult;
      this.results.set(result.requestId, result);
      return Response.json({ ok: true, data: { requestId: result.requestId } });
    });
  }
}

interface TestContext {
  bridge: BrowserControlBridge;
  broker: FakeBroker;
  chromeStub: ChromeStub;
  server: Bun.Server;
}

const contexts: TestContext[] = [];

async function createContext(): Promise<TestContext> {
  const chromeStub = installChromeStub();
  const broker = new FakeBroker();
  const server = Bun.serve({
    port: 0,
    fetch: (request) => broker.handle(request),
  });
  const bridge = new BrowserControlBridge(`http://127.0.0.1:${server.port}`);
  const context = { bridge, broker, chromeStub, server };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) break;
    await context.bridge.stop();
    context.server.stop(true);
  }
});

describe("BrowserControlBridge bind", () => {
  test("binds the session, stores the connection, and starts leasing", async () => {
    const { bridge, broker, chromeStub } = await createContext();

    const bound = await bridge.bind("ses_1");
    expect(bound).toBe(true);
    expect(broker.bindCount).toBe(1);

    await Bun.sleep(50);
    expect(chromeStub.store.get("astra.browser.connection")).toMatchObject({
      sessionId: "ses_1",
      connectionToken: "token-1",
      generation: 1,
    });
    expect(broker.leaseCalls.length).toBeGreaterThan(0);
    expect(broker.leaseCalls[0]?.token).toBe("token-1");

    const rebound = await bridge.bind("ses_1");
    expect(rebound).toBe(true);
    expect(broker.bindCount).toBe(1);
  });
});

describe("BrowserControlBridge request cycle", () => {
  test("settles a leased request with broker_unavailable when no dispatcher is set", async () => {
    const { bridge, broker } = await createContext();
    await bridge.bind("ses_1");

    const enqueued = broker.enqueue("ses_1");
    await Bun.sleep(100);

    const settled = broker.results.get(enqueued.requestId);
    expect(settled).toMatchObject({
      requestId: enqueued.requestId,
      sessionId: "ses_1",
      status: "failed",
    });
    if (settled?.status === "failed") {
      expect(settled.error.code).toBe("broker_unavailable");
    }
  });

  test("dispatches a leased request and delivers the returned result", async () => {
    const { bridge, broker } = await createContext();
    const observed: BrowserWorkRequest[] = [];

    bridge.setDispatcher(async (request) => {
      observed.push(request);
      return {
        requestId: request.requestId,
        sessionId: request.sessionId,
        status: "completed",
        payload: { title: "Example Domain" },
        completedAt: new Date().toISOString(),
      };
    });
    await bridge.bind("ses_1");

    const enqueued = broker.enqueue("ses_1");
    await Bun.sleep(100);

    expect(observed).toHaveLength(1);
    expect(observed[0]?.requestId).toBe(enqueued.requestId);
    expect(broker.results.get(enqueued.requestId)).toMatchObject({
      status: "completed",
    });
  });

  test("a dispatcher throw still settles the request as a typed failure", async () => {
    const { bridge, broker } = await createContext();
    bridge.setDispatcher(async () => {
      throw new Error("tab vanished");
    });
    await bridge.bind("ses_1");

    const enqueued = broker.enqueue("ses_1");
    await Bun.sleep(100);

    const settled = broker.results.get(enqueued.requestId);
    expect(settled?.status).toBe("failed");
    if (settled?.status === "failed") {
      expect(settled.error.code).toBe("broker_unavailable");
    }
  });
});

describe("BrowserControlBridge lifecycle", () => {
  test("an invalid-token lease stops the loop and clears the stored connection", async () => {
    const { bridge, broker, chromeStub } = await createContext();
    await bridge.bind("ses_1");
    await Bun.sleep(50);
    expect(broker.leaseCalls.length).toBeGreaterThan(0);

    broker.failLeaseWithInvalidToken = true;
    const cleared = await waitFor(
      () => chromeStub.store.get("astra.browser.connection") === undefined,
    );
    expect(cleared).toBe(true);

    const leasesAfterStop = broker.leaseCalls.length;
    await Bun.sleep(300);
    expect(broker.leaseCalls.length).toBe(leasesAfterStop);
  });

  test("rebinding rotates the connection and keeps leasing under the new token", async () => {
    const { bridge, broker, chromeStub } = await createContext();
    await bridge.bind("ses_1");
    await Bun.sleep(50);
    expect(broker.leaseCalls[0]?.token).toBe("token-1");

    await bridge.bind("ses_2");
    await Bun.sleep(100);

    expect(broker.bindCount).toBe(2);
    expect(chromeStub.store.get("astra.browser.connection")).toMatchObject({
      sessionId: "ses_2",
      connectionToken: "token-2",
      generation: 2,
    });
    const recentTokens = broker.leaseCalls.slice(-3).map((call) => call.token);
    expect(recentTokens).toContain("token-2");
  });

  test("stop aborts the in-flight long poll promptly", async () => {
    const { bridge, broker } = await createContext();
    await bridge.bind("ses_1");
    await Bun.sleep(50);
    const leasesAtStop = broker.leaseCalls.length;

    const started = Date.now();
    await bridge.stop();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(500);
    const leasesAfterStop = broker.leaseCalls.length;
    await Bun.sleep(300);
    expect(broker.leaseCalls.length).toBe(leasesAfterStop);
    expect(leasesAfterStop).toBeGreaterThanOrEqual(leasesAtStop);
  });
});
