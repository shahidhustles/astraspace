export interface InvalidUrlError {
  code: "invalid_url";
  message: string;
}

export interface UnsupportedPageError {
  code: "unsupported_page";
  message: string;
  url: string;
}

export interface UrlDeniedError {
  code: "url_denied";
  message: string;
  url: string;
}

export interface AttachFailedError {
  code: "attach_failed";
  message: string;
}

export interface ActiveTabUnavailableError {
  code: "active_tab_unavailable";
  message: string;
}

export interface InaccessibleTabError {
  code: "inaccessible_tab";
  message: string;
}

export interface AttachConflictError {
  code: "attach_conflict";
  message: string;
}

export type BrowserError =
  | InvalidUrlError
  | UnsupportedPageError
  | UrlDeniedError
  | AttachFailedError
  | ActiveTabUnavailableError
  | InaccessibleTabError
  | AttachConflictError;

export type UrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; error: BrowserError };

export type DiagnosticEvent =
  | { type: "attach_started"; tabId: number }
  | { type: "attach_ok"; tabId: number }
  | { type: "attach_reused"; tabId: number }
  | { type: "attach_failed"; tabId: number; code: BrowserError["code"] };