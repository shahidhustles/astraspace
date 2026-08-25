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

export type BrowserError = InvalidUrlError | UnsupportedPageError | UrlDeniedError;

export type UrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; error: BrowserError };