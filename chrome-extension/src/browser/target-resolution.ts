import type {
  ElementHandle,
  Frame,
  JSHandle,
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
      if (await verifyCandidate(frame, candidate, lookup.grounding)) {
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
    created.push(...(await locateByCssSegments(frame, grounding.cssSegments)));
    created.push(...(await locateByXpathSegments(frame, grounding.xpathSegments)));
    created.push(...(await locateInRecordedScope(frame, grounding)));
    created.push(...(await locateByBounds(frame, grounding)));
    return await dedupeByBackendNodeId(created);
  } catch (error) {
    await disposeElements(created);
    throw error;
  }
}

export async function verifyCandidate(
  frame: Frame,
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
  const ax = await frame.accessibility.snapshot({ root: element, interestingOnly: false });
  if (!ax) {
    return false;
  }
  if (grounding.role !== null && ax.role !== grounding.role) {
    return false;
  }
  if (grounding.name !== null && ax.name !== grounding.name) {
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
): Promise<ElementHandle[]> {
  if (segments.length === 0) {
    return [];
  }
  return evaluateElements(frame, (segments: string[]) => {
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
        return [];
      }
    }
    return current;
  }, [...segments]);
}

async function locateByXpathSegments(
  frame: Frame,
  segments: readonly string[],
): Promise<ElementHandle[]> {
  if (segments.length === 0) {
    return [];
  }
  return evaluateElements(frame, (segments: string[]) => {
    const body = document.body;
    if (!body) {
      return [];
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
        return [];
      }
    }
    return current;
  }, [...segments]);
}

async function locateInRecordedScope(
  frame: Frame,
  grounding: CommittedGroundingRecord,
): Promise<ElementHandle[]> {
  const hasShadowBoundary = grounding.domPath.some((step) => step.kind === "shadow");
  if (hasShadowBoundary && grounding.cssSegments.length <= 1) {
    return [];
  }
  if (grounding.cssSegments.length <= 1) {
    return frame.$$(grounding.tag);
  }
  return evaluateElements(frame, (segments: string[], tag: string) => {
    let hosts = [...document.querySelectorAll(segments[0])];
    for (let i = 1; i < segments.length - 1; i++) {
      const nextHosts: Element[] = [];
      for (const host of hosts) {
        if (host.shadowRoot) {
          nextHosts.push(...host.shadowRoot.querySelectorAll(segments[i]));
        }
      }
      hosts = nextHosts;
    }
    const matches: Element[] = [];
    for (const host of hosts) {
      if (host.shadowRoot) {
        matches.push(...host.shadowRoot.querySelectorAll(tag));
      }
    }
    return matches;
  }, [...grounding.cssSegments], grounding.tag);
}

async function locateByBounds(frame: Frame, grounding: CommittedGroundingRecord): Promise<ElementHandle[]> {
  const bounds = grounding.bounds;
  if (bounds === null) {
    return [];
  }
  const hasShadowBoundary = grounding.domPath.some((step) => step.kind === "shadow");
  if (hasShadowBoundary && grounding.cssSegments.length <= 1) {
    return [];
  }
  return evaluateElements(frame, (segments: string[], tag: string, bounds: RectBounds) => {
    let candidates: Element[];
    if (segments.length <= 1) {
      candidates = [...document.querySelectorAll(tag)];
    } else {
      let hosts = [...document.querySelectorAll(segments[0])];
      for (let i = 1; i < segments.length - 1; i++) {
        const nextHosts: Element[] = [];
        for (const host of hosts) {
          if (host.shadowRoot) {
            nextHosts.push(...host.shadowRoot.querySelectorAll(segments[i]));
          }
        }
        hosts = nextHosts;
      }
      candidates = hosts.flatMap((host) =>
        host.shadowRoot ? [...host.shadowRoot.querySelectorAll(tag)] : [],
      );
    }
    return candidates.filter((el) => {
      const rect = el.getBoundingClientRect();
      return (
        Math.abs(rect.x - bounds.x) <= 1 &&
        Math.abs(rect.y - bounds.y) <= 1 &&
        Math.abs(rect.width - bounds.width) <= 1 &&
        Math.abs(rect.height - bounds.height) <= 1
      );
    });
  }, [...grounding.cssSegments], grounding.tag, { ...bounds });
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

async function evaluateElements<Args extends unknown[]>(
  frame: Frame,
  fn: (...args: Args) => Element[],
  ...args: Args
): Promise<ElementHandle[]> {
  const collection = await frame.evaluateHandle(fn as (...args: unknown[]) => unknown, ...args);
  const elements: ElementHandle[] = [];
  try {
    const properties = await collection.getProperties();
    for (const [name, handle] of [...properties.entries()].sort(([left], [right]) => Number(left) - Number(right))) {
      if (!/^\d+$/.test(name)) {
        await handle.dispose().catch(() => {});
        continue;
      }
      const element = handle.asElement();
      if (element && await element.evaluate((node) => node instanceof Element)) {
        elements.push(element as ElementHandle<Element>);
      } else {
        await handle.dispose().catch(() => {});
      }
    }
    return elements;
  } catch (error) {
    await disposeElements(elements);
    throw error;
  } finally {
    await collection.dispose().catch(() => {});
  }
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
