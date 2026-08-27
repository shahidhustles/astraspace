import type { UnsupportedRedirectError, UrlPolicyResult } from "./types";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const UNSUPPORTED_PROTOCOLS = new Set(["chrome:", "chrome-extension:", "about:"]);

function isChromeWebStore(url: URL): boolean {
  if (url.hostname === "chromewebstore.google.com") {
    return true;
  }
  return url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore");
}

export function enforceUrlPolicy(raw: string): UrlPolicyResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "invalid_url", message: "URL is empty" } };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: { code: "invalid_url", message: "Malformed URL" } };
  }

  if (UNSUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      error: { code: "unsupported_page", message: "Unsupported browser page", url: trimmed },
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      error: { code: "url_denied", message: `Blocked URL scheme: ${parsed.protocol}`, url: trimmed },
    };
  }

  if (isChromeWebStore(parsed)) {
    return {
      ok: false,
      error: { code: "unsupported_page", message: "Chrome Web Store is not supported", url: trimmed },
    };
  }

  return { ok: true, url: parsed.toString() };
}

// Classifies a navigation's final URL. Any disallowed destination counts as
// an unsupported redirect and fails closed with the tab's typed error.
export function redirectPolicyError(raw: string): UnsupportedRedirectError | null {
  if (enforceUrlPolicy(raw).ok) {
    return null;
  }
  return { code: "unsupported_redirect", message: "Navigation ended on an unsupported page", url: raw };
}