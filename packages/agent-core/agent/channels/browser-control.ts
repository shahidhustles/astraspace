import { defineChannel, GET, POST } from "eve/channels";
import {
  ASTRA_EXTENSION_ORIGIN,
  BROWSER_CONTROL_BIND_PATH,
  BROWSER_CONTROL_CONNECTION_HEADER,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_RESULTS_PATH,
  BROWSER_CONTROL_REQUESTS_PATH,
  MAX_LONG_POLL_MS,
  type BrowserBindResult,
  type BrowserControlBody,
  type BrowserControlErrorCode,
  type BrowserLeaseResult,
  browserControlFailure,
  isBrowserBindRequest,
  isBrowserWorkResult,
  isConfiguredBrowserControlOrigin,
} from "@astra-space/browser-control-contract";
import { BrowserBroker, BrowserBrokerError } from "../lib/browser-broker";

function jsonBody<TData>(data: TData): Response {
  const body: BrowserControlBody<TData> = { ok: true, data };
  return Response.json(body);
}

function failureBody(code: BrowserControlErrorCode, message: string): Response {
  return Response.json(browserControlFailure({ code, message }));
}

function brokerFailure(error: unknown): Response | null {
  if (!(error instanceof BrowserBrokerError)) return null;
  return Response.json(browserControlFailure({ code: error.code, message: error.message }));
}

function foreignOrigin(request: Request, requireOrigin: boolean): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return requireOrigin;
  return !isConfiguredBrowserControlOrigin(origin);
}

function connectionToken(request: Request): string | null {
  return request.headers.get(BROWSER_CONTROL_CONNECTION_HEADER);
}

export default defineChannel({
  cors: {
    origin: [ASTRA_EXTENSION_ORIGIN],
    methods: ["GET", "POST"],
    allowHeaders: ["content-type", BROWSER_CONTROL_CONNECTION_HEADER],
  },

  routes: [
    POST(BROWSER_CONTROL_BIND_PATH, async (request) => {
      if (foreignOrigin(request, true)) {
        return failureBody("invalid_origin", "Browser control accepts only the Astra extension origin");
      }

      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return failureBody("malformed_envelope", "Bind body must be JSON");
      }

      if (
        typeof body === "object" &&
        body !== null &&
        "protocolVersion" in body &&
        (body as { protocolVersion?: unknown }).protocolVersion !== BROWSER_CONTROL_PROTOCOL_VERSION
      ) {
        return failureBody("protocol_mismatch", "Browser control protocol version does not match");
      }
      if (!isBrowserBindRequest(body)) {
        return failureBody("malformed_envelope", "Bind envelope is not valid");
      }

      try {
        const bind: BrowserBindResult = await BrowserBroker.shared().bind(body.sessionId);
        return jsonBody(bind);
      } catch (error) {
        return brokerFailure(error) ?? failureBody("broker_unavailable", "Bind failed");
      }
    }),

    GET(BROWSER_CONTROL_REQUESTS_PATH, async (request) => {
      const token = connectionToken(request);
      if (token === null) {
        return failureBody("invalid_token", "Browser control requests need a connection token");
      }
      const waitParam = Number(new URL(request.url).searchParams.get("waitMs") ?? "0");
      const waitMs = Number.isFinite(waitParam) ? Math.min(Math.max(waitParam, 0), MAX_LONG_POLL_MS) : 0;

      try {
        const lease: BrowserLeaseResult = await BrowserBroker.shared().lease(token, waitMs);
        return jsonBody(lease);
      } catch (error) {
        return brokerFailure(error) ?? failureBody("broker_unavailable", "Lease failed");
      }
    }),

    POST(BROWSER_CONTROL_RESULTS_PATH, async (request) => {
      if (foreignOrigin(request, true)) {
        return failureBody("invalid_origin", "Browser control accepts only the Astra extension origin");
      }
      const token = connectionToken(request);
      if (token === null) {
        return failureBody("invalid_token", "Browser control results need a connection token");
      }

      let body: unknown = null;
      try {
        body = await request.json();
      } catch {
        return failureBody("malformed_envelope", "Result body must be JSON");
      }
      if (!isBrowserWorkResult(body)) {
        return failureBody("malformed_envelope", "Result envelope is not valid");
      }

      try {
        await BrowserBroker.shared().submitResult(token, body);
        return jsonBody({ requestId: body.requestId });
      } catch (error) {
        return brokerFailure(error) ?? failureBody("broker_unavailable", "Result delivery failed");
      }
    }),
  ],
});
