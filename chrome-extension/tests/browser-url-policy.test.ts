import { describe, expect, test } from "bun:test";
import { enforceUrlPolicy } from "../src/browser/url-policy";

function expectAccepted(input: string, expected: string) {
  expect(enforceUrlPolicy(input)).toEqual({ ok: true, url: expected });
}

function expectCode(input: string, code: "invalid_url" | "unsupported_page" | "url_denied") {
  const result = enforceUrlPolicy(input);
  if (result.ok) {
    throw new Error(`expected ${code} for ${input}`);
  }
  expect(result.error.code).toBe(code);
}

describe("enforceUrlPolicy", () => {
  test("accepts http and https URLs", () => {
    expectAccepted("https://example.com", "https://example.com/");
    expectAccepted("http://example.com", "http://example.com/");
    expectAccepted("https://example.com/path?q=1#frag", "https://example.com/path?q=1#frag");
    expectAccepted("http://localhost:3000", "http://localhost:3000/");
    expectAccepted("HTTPS://EXAMPLE.com", "https://example.com/");
    expectAccepted("  https://example.com  ", "https://example.com/");
  });

  test("rejects malformed URLs as invalid_url", () => {
    expectCode("", "invalid_url");
    expectCode("   ", "invalid_url");
    expectCode("not a url", "invalid_url");
    expectCode("example.com", "invalid_url");
    expectCode("http://", "invalid_url");
    expectCode("https://exa mple.com", "invalid_url");
  });

  test("rejects Chrome and extension pages as unsupported_page", () => {
    expectCode("chrome://newtab", "unsupported_page");
    expectCode("chrome://settings/", "unsupported_page");
    expectCode("chrome-extension://abc123/", "unsupported_page");
    expectCode("about:blank", "unsupported_page");
  });

  test("rejects the Chrome Web Store as unsupported_page", () => {
    expectCode("https://chromewebstore.google.com/detail/xyz", "unsupported_page");
    expectCode("https://chrome.google.com/webstore/detail/xyz", "unsupported_page");
  });

  test("rejects blocked schemes as url_denied", () => {
    expectCode("file:///etc/passwd", "url_denied");
    expectCode("data:text/html,hi", "url_denied");
    expectCode("javascript:alert(1)", "url_denied");
    expectCode("JavaScript:alert(1)", "url_denied");
    expectCode("vbscript:x", "url_denied");
    expectCode("ws://example.com", "url_denied");
    expectCode("wss://example.com", "url_denied");
    expectCode("ftp://example.com", "url_denied");
    expectCode("mailto:a@b.com", "url_denied");
  });
});