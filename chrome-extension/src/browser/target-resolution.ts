import type { ElementHandle, Page } from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { FrameIdentity } from "./document-identity";
import type { CommittedGroundingRecord } from "./observation/types";
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
  readLiveIdentity: () => FrameIdentity | null,
): Promise<TargetResolutionResult> {
  const initialIdentity = readLiveIdentity();
  if (!initialIdentity) {
    return staleTarget(target, "The page connection is no longer live");
  }
  const lookup = store.lookup(target, initialIdentity);
  if (!lookup.ok) {
    return lookup;
  }
  let candidates: ElementHandle[] = [];
  const verified: ElementHandle[] = [];
  try {
    candidates = await locateCandidates(page, lookup.grounding);
    for (const candidate of candidates) {
      if (await verifyCandidate(page, candidate, lookup.grounding)) {
        verified.push(candidate);
      }
    }
    await disposeElements(candidates.filter((candidate) => !verified.includes(candidate)));

    const finalIdentity = readLiveIdentity();
    if (!finalIdentity) {
      await disposeElements(verified);
      return staleTarget(target, "The page connection changed while resolving the target");
    }
    const finalLookup = store.lookup(target, finalIdentity);
    if (!finalLookup.ok) {
      await disposeElements(verified);
      return finalLookup;
    }

    if (verified.length === 0) {
      return { ok: false, code: "target_not_found", target, reason: "No live element matches the recorded target" };
    }
    if (verified.length > 1) {
      await disposeElements(verified);
      return { ok: false, code: "ambiguous_ref", target, reason: "Multiple live elements match the recorded target" };
    }
    return { ok: true, element: verified[0] };
  } catch {
    await disposeElements(candidates);
    const finalIdentity = readLiveIdentity();
    if (!finalIdentity) {
      return staleTarget(target, "The page connection changed while resolving the target");
    }
    const finalLookup = store.lookup(target, finalIdentity);
    if (!finalLookup.ok) {
      return finalLookup;
    }
    return { ok: false, code: "target_not_found", target, reason: "The live target could not be resolved" };
  }
}

export async function locateCandidates(page: Page, grounding: CommittedGroundingRecord): Promise<ElementHandle[]> {
  const pathElement = await resolveDomPath(page, grounding.domPath);
  let matches: ElementHandle[];
  try {
    matches = await page.$$(grounding.tag);
  } catch (error) {
    await disposeElements(pathElement ? [pathElement] : []);
    throw error;
  }
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
  grounding: CommittedGroundingRecord,
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

async function resolveDomPath(page: Page, domPath: readonly number[]): Promise<ElementHandle | null> {
  const handle = await page.evaluateHandle((path: readonly number[]) => {
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

function stableAttributeNames(grounding: CommittedGroundingRecord): string[] {
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

function staleTarget(target: GroundedTarget, reason: string): TargetResolutionResult {
  return { ok: false, code: "stale_ref", target, reason };
}

async function disposeElements(elements: ElementHandle[]): Promise<void> {
  await Promise.all(elements.map((element) => element.dispose().catch(() => {})));
}
