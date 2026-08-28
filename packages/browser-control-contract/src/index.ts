export const BROWSER_CONTROL_PROTOCOL_VERSION = 1;

export const BROWSER_CONTROL_BIND_PATH = "/astra/v1/browser-control/bind";
export const BROWSER_CONTROL_REQUESTS_PATH = "/astra/v1/browser-control/requests";
export const BROWSER_CONTROL_RESULTS_PATH = "/astra/v1/browser-control/results";

export const BROWSER_CONTROL_CONNECTION_HEADER = "x-astra-browser-control";

export const ASTRA_EXTENSION_ORIGIN = "chrome-extension://ldkogpbfmipcomcngekngjfcbkadknlg";

export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export const MAX_LONG_POLL_MS = 20_000;

export type BrowserControlErrorCode =
  | "invalid_origin"
  | "protocol_mismatch"
  | "malformed_envelope"
  | "invalid_token"
  | "invalid_session"
  | "payload_too_large"
  | "unknown_request"
  | "lease_expired"
  | "broker_unavailable";

export interface BrowserControlError {
  code: BrowserControlErrorCode;
  message: string;
}

const BROWSER_CONTROL_ERROR_CODES: readonly BrowserControlErrorCode[] = [
  "invalid_origin",
  "protocol_mismatch",
  "malformed_envelope",
  "invalid_token",
  "invalid_session",
  "payload_too_large",
  "unknown_request",
  "lease_expired",
  "broker_unavailable",
];

export function isBrowserControlErrorCode(value: unknown): value is BrowserControlErrorCode {
  return (
    typeof value === "string" &&
    (BROWSER_CONTROL_ERROR_CODES as readonly string[]).includes(value)
  );
}

export interface BrowserControlErrorBody {
  readonly ok: false;
  readonly error: BrowserControlError;
}

export interface BrowserControlOkBody<TData> {
  readonly ok: true;
  readonly data: TData;
}

export type BrowserControlBody<TData> =
  | BrowserControlOkBody<TData>
  | BrowserControlErrorBody;

export function browserControlFailure(error: BrowserControlError): BrowserControlErrorBody {
  return { ok: false, error };
}

export interface BrowserBindRequest {
  sessionId: string;
  protocolVersion: number;
}

export interface BrowserBindResult {
  sessionId: string;
  connectionToken: string;
  generation: number;
}

export interface BrowserWorkRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  callId: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type BrowserWorkResult =
  | {
      requestId: string;
      sessionId: string;
      status: "completed";
      payload: Record<string, unknown>;
      completedAt: string;
    }
  | {
      requestId: string;
      sessionId: string;
      status: "failed";
      error: BrowserControlError;
      completedAt: string;
    }
  | {
      requestId: string;
      sessionId: string;
      status: "cancelled";
      completedAt: string;
    };

export interface BrowserLeaseResult {
  requests: BrowserWorkRequest[];
}

export function isConfiguredBrowserControlOrigin(
  origin: string | null | undefined,
): origin is string {
  return origin === ASTRA_EXTENSION_ORIGIN;
}

export function jsonByteSize(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string" && record[key].length > 0;
}

export function isBrowserBindRequest(value: unknown): value is BrowserBindRequest {
  return (
    isRecord(value) &&
    hasString(value, "sessionId") &&
    value.protocolVersion === BROWSER_CONTROL_PROTOCOL_VERSION
  );
}

export function isBrowserWorkRequest(value: unknown): value is BrowserWorkRequest {
  return (
    isRecord(value) &&
    hasString(value, "requestId") &&
    hasString(value, "sessionId") &&
    hasString(value, "turnId") &&
    hasString(value, "callId") &&
    typeof value.kind === "string" &&
    isRecord(value.payload) &&
    typeof value.createdAt === "string"
  );
}

export function isBrowserWorkResult(value: unknown): value is BrowserWorkResult {
  if (!isRecord(value) || !hasString(value, "requestId") || !hasString(value, "sessionId")) {
    return false;
  }
  if (typeof value.completedAt !== "string") return false;

  if (value.status === "completed") return isRecord(value.payload);
  if (value.status === "failed") {
    return (
      isRecord(value.error) &&
      isBrowserControlErrorCode(value.error.code) &&
      typeof value.error.message === "string"
    );
  }
  return value.status === "cancelled";
}

export function isBrowserControlBody<TData>(
  value: unknown,
  isData: (data: unknown) => data is TData,
): value is BrowserControlBody<TData> {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok === false) {
    return (
      isRecord(value.error) &&
      isBrowserControlErrorCode(value.error.code) &&
      typeof value.error.message === "string"
    );
  }
  return isData(value.data);
}
