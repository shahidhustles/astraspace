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
  | "broker_unavailable"
  | "browser_unavailable";

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
  "browser_unavailable",
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

export const BROWSER_WORK_KIND_OBSERVE = "browser.observe";

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

export interface BrowserObserveBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserObserveScroll {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  atTop: boolean;
  atBottom: boolean;
  atLeft: boolean;
  atRight: boolean;
}

export interface BrowserObserveTab {
  tabId: number;
  url: string;
  title: string;
  attached: boolean;
  selected: boolean;
}

export interface BrowserObserveRef {
  ref: number;
  tag: string;
  role: string | null;
  name: string | null;
  attrs: Record<string, string>;
  bounds: BrowserObserveBounds | null;
}

export interface BrowserObserveSnapshot {
  snapshotId: string;
  snapshotVersion: number;
  documentEpoch: number;
  navigationEpoch: number;
}

export interface BrowserObserveScreenshot {
  mimeType: "image/jpeg";
  data: string;
  width: number;
  height: number;
}

export interface BrowserObserveState {
  tabs: BrowserObserveTab[];
  tabId: number;
  url: string;
  title: string;
  scroll: BrowserObserveScroll;
  snapshot: BrowserObserveSnapshot;
  refs: BrowserObserveRef[];
  dom: string;
  screenshot: BrowserObserveScreenshot;
}

export type BrowserObservationErrorCode =
  | "invalid_url"
  | "unsupported_page"
  | "url_denied"
  | "attach_failed"
  | "active_tab_unavailable"
  | "inaccessible_tab"
  | "attach_conflict"
  | "missing_tab"
  | "chrome_api_error"
  | "lifecycle_timeout"
  | "selected_tab_unavailable"
  | "unsupported_redirect"
  | "navigation_timeout"
  | "navigation_failed"
  | "disconnect_failed"
  | "observation_failed";

const BROWSER_OBSERVATION_ERROR_CODES: readonly BrowserObservationErrorCode[] = [
  "invalid_url",
  "unsupported_page",
  "url_denied",
  "attach_failed",
  "active_tab_unavailable",
  "inaccessible_tab",
  "attach_conflict",
  "missing_tab",
  "chrome_api_error",
  "lifecycle_timeout",
  "selected_tab_unavailable",
  "unsupported_redirect",
  "navigation_timeout",
  "navigation_failed",
  "disconnect_failed",
  "observation_failed",
];

export interface BrowserObservationError {
  code: BrowserObservationErrorCode;
  message: string;
}

export type BrowserObserveResultPayload =
  | { ok: true; state: BrowserObserveState }
  | { ok: false; error: BrowserObservationError };

function isBrowserObserveBounds(value: unknown): value is BrowserObserveBounds {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function isBrowserObserveScroll(value: unknown): value is BrowserObserveScroll {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.maxX === "number" &&
    typeof value.maxY === "number" &&
    typeof value.atTop === "boolean" &&
    typeof value.atBottom === "boolean" &&
    typeof value.atLeft === "boolean" &&
    typeof value.atRight === "boolean"
  );
}

function isBrowserObserveTab(value: unknown): value is BrowserObserveTab {
  if (!isRecord(value)) return false;
  return (
    typeof value.tabId === "number" &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.attached === "boolean" &&
    typeof value.selected === "boolean"
  );
}

function isBrowserObserveRef(value: unknown): value is BrowserObserveRef {
  if (!isRecord(value)) return false;
  if (
    typeof value.ref !== "number" ||
    typeof value.tag !== "string" ||
    (value.role !== null && typeof value.role !== "string") ||
    (value.name !== null && typeof value.name !== "string") ||
    (value.bounds !== null && !isBrowserObserveBounds(value.bounds))
  ) {
    return false;
  }
  if (!isRecord(value.attrs)) return false;
  return Object.values(value.attrs).every((attr) => typeof attr === "string");
}

function isBrowserObserveSnapshot(value: unknown): value is BrowserObserveSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.snapshotId === "string" &&
    value.snapshotId.length > 0 &&
    typeof value.snapshotVersion === "number" &&
    typeof value.documentEpoch === "number" &&
    typeof value.navigationEpoch === "number"
  );
}

function isBrowserObserveScreenshot(value: unknown): value is BrowserObserveScreenshot {
  if (!isRecord(value)) return false;
  return (
    value.mimeType === "image/jpeg" &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    typeof value.width === "number" &&
    typeof value.height === "number"
  );
}

function isBrowserObserveState(value: unknown): value is BrowserObserveState {
  if (!isRecord(value)) return false;
  if (
    !Array.isArray(value.tabs) ||
    !value.tabs.every(isBrowserObserveTab) ||
    typeof value.tabId !== "number" ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    !isBrowserObserveScroll(value.scroll) ||
    !isBrowserObserveSnapshot(value.snapshot) ||
    !Array.isArray(value.refs) ||
    !value.refs.every(isBrowserObserveRef) ||
    typeof value.dom !== "string" ||
    !isBrowserObserveScreenshot(value.screenshot)
  ) {
    return false;
  }
  return true;
}

export function isBrowserObserveResultPayload(
  value: unknown,
): value is BrowserObserveResultPayload {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) return isBrowserObserveState(value.state);
  return (
    isRecord(value.error) &&
    (BROWSER_OBSERVATION_ERROR_CODES as readonly string[]).includes(
      value.error.code as string,
    ) &&
    typeof value.error.message === "string"
  );
}
