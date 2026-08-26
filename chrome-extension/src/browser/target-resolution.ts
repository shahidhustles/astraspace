import type { ElementHandle, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { FrameIdentity } from "./document-identity";
import type { GroundingRecord } from "./observation/types";
import type { SnapshotStore } from "./snapshot";
import type { GroundedTarget, TargetResolutionResult } from "./types";

const STATE_ATTRIBUTES = new Set([
  "aria-checked",
  "aria-expanded",
  "aria-selected",
  "checked",
  "selected",
  "value",
]);

export async function resolveTarget(
  page: Page,
  store: SnapshotStore,
  target: GroundedTarget,
  live: FrameIdentity,
): Promise<TargetResolutionResult> {
  const lookup = store.lookup(target, live);
  if (!lookup.ok) {
    return lookup;
  }
  const candidates = await locateCandidates(page, lookup.grounding);
  const verified: ElementHandle[] = [];
  for (const candidate of candidates) {
    if (await verifyCandidate(page, candidate, lookup.grounding)) {
      verified.push(candidate);
    } else {
      await candidate.dispose();
    }
  }
  if (verified.length === 0) {
    return { ok: false, code: "target_not_found", target, reason: "No live element matches the recorded target" };
  }
  if (verified.length > 1) {
    await Promise.all(verified.map((element) => element.dispose()));
    return { ok: false, code: "ambiguous_ref", target, reason: "Multiple live elements match the recorded target" };
  }
  return { ok: true, element: verified[0] };
}

export async function locateCandidates(page: Page, grounding: GroundingRecord): Promise<ElementHandle[]> {
  const pathElement = await resolveDomPath(page, grounding.domPath);
  const matches = await page.$$(candidateSelector(grounding));
  if (!pathElement) {
    return matches;
  }
  for (const match of matches) {
    const isSame = await page.evaluate((path, candidate) => path === candidate, pathElement, match);
    if (isSame) {
      await pathElement.dispose();
      return matches;
    }
  }
  return [pathElement, ...matches];
}

export async function verifyCandidate(
  page: Page,
  element: ElementHandle,
  grounding: GroundingRecord,
): Promise<boolean> {
  try {
    const tag = await element.evaluate((node) => node.tagName.toLowerCase());
    if (tag !== grounding.tag) {
      return false;
    }
    const liveAttrs = await element.evaluate(
      (node, names: string[]) => {
        const attrs: Record<string, string> = {};
        for (const name of names) {
          const value = node.getAttribute(name);
          if (value !== null) {
            attrs[name] = value;
          }
        }
        return attrs;
      },
      stableAttributeNames(grounding),
    );
    if (!recordedAttrsMatch(liveAttrs, grounding.attrs)) {
      return false;
    }
    if (grounding.role === null && grounding.name === null) {
      return true;
    }
    const ax = await page.accessibility.snapshot({ root: element, interestingOnly: false });
    if (grounding.role !== null && ax?.role !== grounding.role) {
      return false;
    }
    if (grounding.name !== null && ax?.name !== grounding.name) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveDomPath(page: Page, domPath: number[]): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle((path: number[]) => {
    let node: Node | null = document.body;
    for (const index of path) {
      node = node?.childNodes.item(index) ?? null;
    }
    return node instanceof Element ? node : null;
  }, domPath);
  const element = handle.asElement() as ElementHandle | null;
  if (!element) {
    await handle.dispose();
    return null;
  }
  return element;
}

function candidateSelector(grounding: GroundingRecord): string {
  const parts = [grounding.tag];
  for (const [name, value] of Object.entries(grounding.attrs)) {
    if (STATE_ATTRIBUTES.has(name)) {
      continue;
    }
    parts.push(`[${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`);
  }
  return parts.join("");
}

function stableAttributeNames(grounding: GroundingRecord): string[] {
  return Object.keys(grounding.attrs).filter((name) => !STATE_ATTRIBUTES.has(name));
}

function recordedAttrsMatch(live: Record<string, string>, recorded: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(recorded)) {
    if (STATE_ATTRIBUTES.has(name)) {
      continue;
    }
    if (live[name] !== value) {
      return false;
    }
  }
  return true;
}