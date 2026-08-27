import type { Frame, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { ActionExpectationPolicy } from "../actions/types";
import type { ExpectationScope } from "./types";
import type { ExpectationSignal } from "./types";

// Counts elements whose accessible role and name equal the expectation exactly,
// over light DOM and open shadow roots of one execution context. Hidden
// elements contribute nothing, so an invisible node never settles an appearance
// wait or breaks a disappearance wait. Kept as an expression string so any
// frame can be probed without shipping functions across contexts.
export function expectationCountSource(expected: ActionExpectationPolicy): string {
  const role = JSON.stringify(expected.role.toLowerCase());
  const name = JSON.stringify(expected.name);
  return `(function () {
  var EXPECTED_ROLE = ${role};
  var EXPECTED_NAME = ${name};
  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) { return explicit.toLowerCase(); }
    var tag = el.tagName;
    if (tag === "BUTTON") { return "button"; }
    if (tag === "A" || tag === "AREA") { return el.hasAttribute("href") ? "link" : ""; }
    if (tag === "SELECT") { return "combobox"; }
    if (tag === "TEXTAREA") { return "textbox"; }
    if (tag === "OPTION") { return "option"; }
    if (tag === "IMG") { return el.hasAttribute("alt") ? "img" : ""; }
    if (tag === "DIALOG") { return "dialog"; }
    if (tag === "FORM") { return "form"; }
    if (tag === "H1" || tag === "H2" || tag === "H3" || tag === "H4" || tag === "H5" || tag === "H6") { return "heading"; }
    if (tag === "UL" || tag === "OL") { return "list"; }
    if (tag === "LI") { return "listitem"; }
    if (tag === "NAV") { return "navigation"; }
    if (tag === "MAIN") { return "main"; }
    if (tag === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") { return "checkbox"; }
      if (type === "radio") { return "radio"; }
      if (type === "button" || type === "submit" || type === "reset") { return "button"; }
      if (type === "image") { return "button"; }
      return "textbox";
    }
    return "";
  }
  function accNameOf(el) {
    var labelled = el.getAttribute("aria-label");
    if (labelled && labelled.trim()) { return labelled.trim(); }
    var refs = el.getAttribute("aria-labelledby");
    if (refs) {
      var owner = el.ownerDocument || document;
      var parts = [];
      var ids = refs.trim().split(/\\s+/);
      for (var r = 0; r < ids.length; r++) {
        var target = owner.getElementById(ids[r]);
        if (target) { parts.push((target.textContent || "").trim()); }
      }
      if (parts.length) { return parts.join(" "); }
    }
    var tag = el.tagName;
    if (tag === "IMG" || tag === "AREA") {
      var alt = el.getAttribute("alt");
      return alt === null ? "" : alt.trim();
    }
    if (tag === "INPUT") {
      var type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "image") { return (el.getAttribute("alt") || "").trim(); }
      if (type === "button" || type === "submit" || type === "reset") {
        return (el.getAttribute("value") || "").trim();
      }
    }
    return (el.textContent || "").replace(/\\s+/g, " ").trim();
  }
  function rendered(el) {
    try { return el.getClientRects().length > 0; } catch (e) { return false; }
  }
  var scopes = [document];
  var hosts = document.querySelectorAll("*");
  for (var h = 0; h < hosts.length; h++) {
    if (hosts[h].shadowRoot) { scopes.push(hosts[h].shadowRoot); }
  }
  var count = 0;
  for (var s = 0; s < scopes.length; s++) {
    var els = scopes[s].querySelectorAll("*");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.isConnected || !rendered(el)) { continue; }
      if (roleOf(el) !== EXPECTED_ROLE) { continue; }
      if (accNameOf(el) !== EXPECTED_NAME) { continue; }
      count++;
    }
  }
  return count;
})()`;
}

export interface ExpectationScanResult {
  total: number;
  scopes: Set<ExpectationScope>;
}

// One pass over every live frame. Frames that fail mid-scan (context destroyed,
// detached) drop out instead of throwing, mirroring the DOM sweep contract.
export async function scanExpectation(
  page: Page,
  expected: ActionExpectationPolicy,
): Promise<ExpectationScanResult> {
  const frames = page.frames();
  const mainFrame = page.mainFrame();
  const results = await Promise.allSettled(
    frames.map(async (frame: Frame) => {
      const raw: unknown = await frame.evaluate(expectationCountSource(expected));
      if (typeof raw !== "number" || raw < 0) {
        throw new Error("unusable count");
      }
      return { count: raw, main: frame === mainFrame };
    }),
  );
  let total = 0;
  // Only frames that actually matched contribute scope evidence.
  const scopes = new Set<ExpectationScope>();
  for (const outcome of results) {
    if (outcome.status !== "fulfilled") {
      continue;
    }
    total += outcome.value.count;
    if (outcome.value.count > 0) {
      scopes.add(outcome.value.main ? "main_document" : "child_frame");
    }
  }
  return { total, scopes };
}

// Polls role/name counts across live frames until the expectation is exactly
// satisfied or the budget ends. Ambiguous rounds keep polling in case the
// extra matches were transient; the last verdict wins at the deadline. The
// read-only scan may retry once on a transient failure, always inside the
// original budget.
export async function waitForExpectationSignal(
  page: Page,
  expected: ActionExpectationPolicy,
  budgetMs: number,
  signal: AbortSignal | undefined,
  pollMs: number,
): Promise<ExpectationSignal> {
  const deadline = Date.now() + budgetMs;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  let probeRetried = false;
  let scan: ExpectationScanResult;
  for (;;) {
    if (signal?.aborted) {
      return { status: "cancelled" };
    }
    try {
      scan = await scanExpectation(page, expected);
    } catch {
      if (!probeRetried && Date.now() < deadline) {
        probeRetried = true;
        continue;
      }
      return { status: "unresolved", intent: expected.intent, timeoutMs: budgetMs };
    }
    if (expected.intent === "disappear" && scan.total === 0) {
      return { status: "satisfied", intent: "disappear" };
    }
    if (expected.intent === "appear" && scan.total === 1) {
      const scope = [...scan.scopes][0];
      return { status: "satisfied", intent: "appear", ...(scope ? { scope } : {}) };
    }
    if (Date.now() >= deadline) {
      return scan.total > 1
        ? { status: "ambiguous", intent: expected.intent, matches: scan.total }
        : { status: "unresolved", intent: expected.intent, timeoutMs: budgetMs };
    }
    await sleep(pollMs);
  }
}
