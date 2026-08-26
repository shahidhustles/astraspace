import type {
  ElementHandle,
  Frame,
  JSHandle,
  Page,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import { bindFrameGraph } from "./frame-binding";
import type { CommittedGroundingRecord, PathStep, RectBounds } from "./observation/types";
import type { SnapshotStore } from "./snapshot";
import type { GroundedTarget, ResolutionContext, TargetResolutionResult } from "./types";

const STATE_ATTRIBUTES = new Set([
  "aria-checked",
  "aria-expanded",
  "aria-selected",
  "checked",
  "selected",
  "value",
]);

const MAX_RESOLUTION_ATTEMPTS = 2;

type AttemptOutcome =
  | { kind: "result"; result: TargetResolutionResult }
  | { kind: "retry" };

export async function resolveTarget(
  ctx: ResolutionContext,
  store: SnapshotStore,
  target: GroundedTarget,
): Promise<TargetResolutionResult> {
  for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt++) {
    const outcome = await attemptResolve(ctx, store, target);
    if (outcome.kind === "result") {
      return outcome.result;
    }
  }
  return {
    ok: false,
    code: "target_not_found",
    target,
    reason: "The live target kept detaching during resolution",
  };
}

async function attemptResolve(
  ctx: ResolutionContext,
  store: SnapshotStore,
  target: GroundedTarget,
): Promise<AttemptOutcome> {
  const identity = ctx.tracker.identity;
  if (!identity) {
    return { kind: "result", result: staleTarget(target, "The page connection is no longer live") };
  }
  const lookup = store.lookup(target, identity, (frameId) => ctx.tracker.record(frameId));
  if (!lookup.ok) {
    return { kind: "result", result: lookup };
  }
  const binding = await bindFrameGraph(ctx.page, ctx.tracker, ctx.session);
  if (!binding.ok) {
    return { kind: "result", result: staleTarget(target, "The frame graph could not be bound during resolution") };
  }
  const frame = frameForGrounding(binding.frameIds, lookup.grounding, ctx.tracker.mainFrameId);
  if (!frame) {
    return { kind: "result", result: staleTarget(target, "The target frame is no longer live") };
  }

  let candidates: ElementHandle[] = [];
  try {
    candidates = await locateCandidates(frame, lookup.grounding);
  } catch {
    await disposeElements(candidates);
    return detachmentOutcome(ctx, store, target);
  }
  const verified: ElementHandle[] = [];
  try {
    for (const candidate of candidates) {
      if (await verifyCandidate(ctx.page, candidate, lookup.grounding)) {
        verified.push(candidate);
      }
    }
  } catch {
    await disposeElements(candidates);
    return detachmentOutcome(ctx, store, target);
  }
  await disposeElements(candidates.filter((candidate) => !verified.includes(candidate)));

  const finalIdentity = ctx.tracker.identity;
  if (!finalIdentity) {
    await disposeElements(verified);
    return { kind: "result", result: staleTarget(target, "The page connection changed while resolving the target") };
  }
  const finalLookup = store.lookup(target, finalIdentity, (frameId) => ctx.tracker.record(frameId));
  if (!finalLookup.ok) {
    await disposeElements(verified);
    return { kind: "result", result: finalLookup };
  }

  if (verified.length === 0) {
    return {
      kind: "result",
      result: { ok: false, code: "target_not_found", target, reason: "No live element matches the recorded target" },
    };
  }
  if (verified.length > 1) {
    await disposeElements(verified);
    return {
      kind: "result",
      result: { ok: false, code: "ambiguous_ref", target, reason: "Multiple live elements match the recorded target" },
    };
  }
  return { kind: "result", result: { ok: true, element: verified[0] } };
}

async function detachmentOutcome(
  ctx: ResolutionContext,
  store: SnapshotStore,
  target: GroundedTarget,
): Promise<AttemptOutcome> {
  const identity = ctx.tracker.identity;
  if (!identity) {
    return { kind: "result", result: staleTarget(target, "The page connection changed while resolving the target") };
  }
  const lookup = store.lookup(target, identity, (frameId) => ctx.tracker.record(frameId));
  if (!lookup.ok) {
    return { kind: "result", result: lookup };
  }
  return { kind: "retry" };
}

export async function locateCandidates(
  frame: Frame,
  grounding: CommittedGroundingRecord,
): Promise<ElementHandle[]> {
  const created: ElementHandle[] = [];
  try {
    if (grounding.backendNodeId !== null) {
      const backendElement = await locateByBackendNodeId(frame, grounding.backendNodeId);
      if (backendElement) {
        created.push(backendElement);
      }
    }
    const pathElement = await resolveDomPath(frame, grounding.domPath);
    if (pathElement) {
      created.push(pathElement);
    }
    const cssElement = await locateByCssSegments(frame, grounding.cssSegments);
    if (cssElement) {
      created.push(cssElement);
    }
    const xpathElement = await locateByXpathSegments(frame, grounding.xpathSegments);
    if (xpathElement) {
      created.push(xpathElement);
    }
    created.push(...(await frame.$$(grounding.tag)));
    const boundsElement = await locateByBounds(frame, grounding);
    if (boundsElement) {
      created.push(boundsElement);
    }
    return await dedupeByBackendNodeId(created);
  } catch (error) {
    await disposeElements(created);
    throw error;
  }
}

export async function verifyCandidate(
  page: Page,
  element: ElementHandle,
  grounding: CommittedGroundingRecord,
): Promise<boolean> {
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
  if (grounding.text !== null) {
    const liveText = await element.evaluate((node) => {
      const parts: string[] = [];
      const walk = (current: Node): void => {
        if (current.nodeType === 3) {
          const text = (current.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text) {
            parts.push(text);
          }
          return;
        }
        if (current.nodeType !== 1) {
          return;
        }
        const el = current as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "svg" || tag === "template" || tag === "noscript") {
          return;
        }
        if (tag === "img" || (tag === "input" && el.getAttribute("type") === "image")) {
          const alt = el.getAttribute("alt");
          if (alt && alt.trim()) {
            parts.push(alt.replace(/\s+/g, " ").trim());
          }
          return;
        }
        for (const child of Array.from(el.childNodes)) {
          walk(child);
        }
      };
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
      return parts.join(" ").trim();
    });
    if (liveText !== grounding.text) {
      return false;
    }
  }
  if (grounding.role === null && grounding.name === null) {
    return true;
  }
  const ax = await page.accessibility.snapshot({ root: element, interestingOnly: false });
  if (ax?.role !== undefined && grounding.role !== null && ax.role !== grounding.role) {
    return false;
  }
  if (ax?.name !== undefined && grounding.name !== null && ax.name !== grounding.name) {
    return false;
  }
  return true;
}

async function locateByBackendNodeId(frame: Frame, backendNodeId: number): Promise<ElementHandle | null> {
  let handle: JSHandle;
  try {
    handle = await frame.mainRealm().adoptBackendNode(backendNodeId);
  } catch {
    return null;
  }
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return element as ElementHandle;
}

async function resolveDomPath(frame: Frame, domPath: readonly PathStep[]): Promise<ElementHandle | null> {
  return evaluateSingleElement(frame, (path: readonly PathStep[]) => {
    let node: Node | null = document.body;
    for (const step of path) {
      if (step.kind === "shadow") {
        node = node instanceof Element ? node.shadowRoot : null;
      } else {
        node = node?.childNodes.item(step.index) ?? null;
      }
    }
    return node instanceof Element ? node : null;
  }, domPath);
}

async function locateByCssSegments(
  frame: Frame,
  segments: readonly string[],
): Promise<ElementHandle | null> {
  if (segments.length === 0) {
    return null;
  }
  return evaluateSingleElement(frame, (segments: string[]) => {
    let current = [...document.querySelectorAll(segments[0])];
    for (let i = 1; i < segments.length; i++) {
      const next: Element[] = [];
      for (const el of current) {
        if (el.shadowRoot) {
          next.push(...el.shadowRoot.querySelectorAll(segments[i]));
        }
      }
      current = next;
      if (current.length === 0) {
        return null;
      }
    }
    return current[0] ?? null;
  }, [...segments]);
}

async function locateByXpathSegments(
  frame: Frame,
  segments: readonly string[],
): Promise<ElementHandle | null> {
  if (segments.length === 0) {
    return null;
  }
  return evaluateSingleElement(frame, (segments: string[]) => {
    const body = document.body;
    if (!body) {
      return null;
    }
    const evalIn = (scope: Node, segment: string): Element[] => {
      const result = document.evaluate(
        `.${segment}`,
        scope,
        null,
        window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null,
      );
      const out: Element[] = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        const node = result.snapshotItem(i);
        if (node instanceof Element) {
          out.push(node);
        }
      }
      return out;
    };
    let current = evalIn(body, segments[0]);
    for (let i = 1; i < segments.length; i++) {
      const next: Element[] = [];
      for (const el of current) {
        if (el.shadowRoot) {
          next.push(...evalIn(el.shadowRoot, segments[i]));
        }
      }
      current = next;
      if (current.length === 0) {
        return null;
      }
    }
    return current[0] ?? null;
  }, [...segments]);
}

async function locateByBounds(frame: Frame, grounding: CommittedGroundingRecord): Promise<ElementHandle | null> {
  const bounds = grounding.bounds;
  if (bounds === null) {
    return null;
  }
  return evaluateSingleElement(frame, (tag: string, bounds: RectBounds) => {
    for (const el of document.querySelectorAll(tag)) {
      const rect = el.getBoundingClientRect();
      if (
        Math.abs(rect.x - bounds.x) <= 1 &&
        Math.abs(rect.y - bounds.y) <= 1 &&
        Math.abs(rect.width - bounds.width) <= 1 &&
        Math.abs(rect.height - bounds.height) <= 1
      ) {
        return el;
      }
    }
    return null;
  }, grounding.tag, { ...bounds });
}

async function evaluateSingleElement<Args extends unknown[]>(
  frame: Frame,
  fn: (...args: Args) => Element | null,
  ...args: Args
): Promise<ElementHandle | null> {
  const handle = await frame.evaluateHandle(fn as (...args: unknown[]) => unknown, ...args);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return element as ElementHandle;
}

async function dedupeByBackendNodeId(handles: ElementHandle[]): Promise<ElementHandle[]> {
  const seen = new Set<number>();
  const unique: ElementHandle[] = [];
  const duplicates: ElementHandle[] = [];
  for (const handle of handles) {
    const id = await handle.backendNodeId();
    if (seen.has(id)) {
      duplicates.push(handle);
    } else {
      seen.add(id);
      unique.push(handle);
    }
  }
  await disposeElements(duplicates);
  return unique;
}

function frameForGrounding(
  frameIds: Map<Frame, string>,
  grounding: CommittedGroundingRecord,
  mainFrameId: string,
): Frame | null {
  const targetFrameId = grounding.frameLineage[grounding.frameLineage.length - 1]?.frameId ?? mainFrameId;
  for (const [frame, frameId] of frameIds) {
    if (frameId === targetFrameId) {
      return frame;
    }
  }
  return null;
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