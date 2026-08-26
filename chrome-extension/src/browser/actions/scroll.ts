import type {
  ElementHandle,
  Frame,
} from "puppeteer-core/lib/puppeteer/puppeteer-core-browser.js";
import type { PathStep } from "../observation/types";
import type { GroundedTarget, TargetResolutionResult } from "../types";
import type { BrowserScrollMode, ScrollPosition, ScrollResult } from "./types";

export interface ScrollDeps {
  resolveTarget: (target: GroundedTarget) => Promise<TargetResolutionResult>;
  invalidate: () => void;
  currentUrl: () => string;
  frame: () => Frame | null;
}

export async function scrollGroundedTarget(
  target: GroundedTarget | null,
  mode: BrowserScrollMode,
  deps: ScrollDeps,
): Promise<ScrollResult> {
  if (target === null) {
    return scrollDocument(mode, deps);
  }
  const resolved = await deps.resolveTarget(target);
  if (!resolved.ok) {
    return { ok: false, error: { code: resolved.code, message: resolved.reason, target: resolved.target } };
  }
  const element = resolved.element;
  try {
    const container = await element.evaluate(measureScrollContainer);
    if (!container) {
      return { ok: false, error: { code: "action_failed", message: "Target has no scrollable ancestor" } };
    }
    deps.invalidate();
    const y = scrollTargetY(mode, container.scrollTop, container.maxY, container.clientHeight);
    const position = await element.evaluate(applyContainerScroll, y);
    if (!position) {
      return { ok: false, error: { code: "action_failed", message: "The scroll container disappeared" } };
    }
    return { ok: true, url: deps.currentUrl(), position };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

export async function scrollToVisibleText(
  text: string,
  occurrence: number,
  deps: ScrollDeps,
): Promise<ScrollResult> {
  const frame = deps.frame();
  if (!frame) {
    return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
  }
  const match = await findTextOccurrence(frame, text, occurrence);
  if (!match.ok) {
    return { ok: false, error: { code: "text_not_found", message: match.reason } };
  }
  const element = match.element;
  try {
    deps.invalidate();
    const position = await element.evaluate(scrollElementIntoView);
    return { ok: true, url: deps.currentUrl(), position };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  } finally {
    await element.dispose().catch(() => {});
  }
}

async function scrollDocument(mode: BrowserScrollMode, deps: ScrollDeps): Promise<ScrollResult> {
  const frame = deps.frame();
  if (!frame) {
    return { ok: false, error: { code: "selected_tab_unavailable", message: "No selected live connection" } };
  }
  try {
    const viewport = await frame.evaluate(measureDocumentScroll);
    deps.invalidate();
    const y = scrollTargetY(mode, viewport.scrollTop, viewport.maxY, viewport.clientHeight);
    const position = await frame.evaluate(applyDocumentScroll, y);
    return { ok: true, url: deps.currentUrl(), position };
  } catch {
    return { ok: false, error: { code: "action_failed", message: "Element interaction failed" } };
  }
}

interface TextMatch {
  frame: Frame;
  path: PathStep[];
}

async function findTextOccurrence(
  frame: Frame,
  text: string,
  occurrence: number,
): Promise<{ ok: true; element: ElementHandle<Element> } | { ok: false; reason: string }> {
  let remaining = occurrence;
  for (const candidate of framesInDocumentOrder(frame)) {
    const paths = await candidate.evaluate(findTextOccurrencePaths, text);
    if (paths.length >= remaining) {
      const match: TextMatch = { frame: candidate, path: paths[remaining - 1] };
      const element = await resolvePath(match);
      if (!element) {
        return { ok: false, reason: "The matching element is no longer in the document" };
      }
      return { ok: true, element };
    }
    remaining -= paths.length;
  }
  return { ok: false, reason: `No visible match for occurrence ${occurrence} of the requested text` };
}

function framesInDocumentOrder(frame: Frame): Frame[] {
  const out: Frame[] = [frame];
  for (const child of frame.childFrames()) {
    out.push(...framesInDocumentOrder(child));
  }
  return out;
}

async function resolvePath(match: TextMatch): Promise<ElementHandle<Element> | null> {
  const handle = await match.frame.evaluateHandle(resolveElementAtPath, match.path);
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return element as ElementHandle<Element>;
}

export function scrollTargetY(mode: BrowserScrollMode, currentY: number, maxY: number, viewportHeight: number): number {
  switch (mode.mode) {
    case "page_up":
      return Math.max(0, currentY - viewportHeight);
    case "page_down":
      return Math.min(maxY, currentY + viewportHeight);
    case "top":
      return 0;
    case "bottom":
      return maxY;
    case "percent":
      return Math.round((maxY * mode.percent) / 100);
  }
}

function measureDocumentScroll(): { scrollTop: number; maxY: number; clientHeight: number } {
  const scrollingElement = document.scrollingElement ?? document.documentElement;
  return {
    scrollTop: scrollingElement.scrollTop,
    maxY: Math.max(0, scrollingElement.scrollHeight - window.innerHeight),
    clientHeight: window.innerHeight,
  };
}

function applyDocumentScroll(y: number): ScrollPosition {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return { x: window.scrollX, y: window.scrollY };
}

interface ContainerMetrics {
  scrollTop: number;
  maxY: number;
  clientHeight: number;
}

function measureScrollContainer(el: Element): ContainerMetrics | null {
  // These functions run in the page through Puppeteer, so each must be
  // self-contained: module-scope helpers are not serialized with them.
  let current: Element | null = el;
  while (current) {
    if (current.scrollHeight > current.clientHeight) {
      const overflowY = getComputedStyle(current).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return {
          scrollTop: current.scrollTop,
          maxY: Math.max(0, current.scrollHeight - current.clientHeight),
          clientHeight: current.clientHeight,
        };
      }
    }
    const parent: Node | null = current.parentNode;
    if (parent instanceof ShadowRoot) {
      current = parent.host;
    } else {
      current = current.parentElement;
    }
  }
  return null;
}

function applyContainerScroll(el: Element, y: number): ScrollPosition | null {
  let current: Element | null = el;
  while (current) {
    if (current.scrollHeight > current.clientHeight) {
      const overflowY = getComputedStyle(current).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        current.scrollTo({ top: y, left: 0, behavior: "instant" });
        return { x: current.scrollLeft, y: current.scrollTop };
      }
    }
    const parent: Node | null = current.parentNode;
    if (parent instanceof ShadowRoot) {
      current = parent.host;
    } else {
      current = current.parentElement;
    }
  }
  return null;
}

function scrollElementIntoView(el: Element): ScrollPosition {
  el.scrollIntoView({ behavior: "instant", block: "nearest" });
  let current: Element | null = el;
  while (current) {
    if (current.scrollHeight > current.clientHeight) {
      const overflowY = getComputedStyle(current).overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
        return { x: current.scrollLeft, y: current.scrollTop };
      }
    }
    const parent: Node | null = current.parentNode;
    if (parent instanceof ShadowRoot) {
      current = parent.host;
    } else {
      current = current.parentElement;
    }
  }
  return { x: window.scrollX, y: window.scrollY };
}

function findTextOccurrencePaths(query: string): PathStep[][] {
  const needle = query.toLowerCase();
  const ignoredTags = new Set(["script", "style", "template", "noscript", "svg"]);
  const isVisibleElement = (el: Element): boolean => {
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility();
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  const paths: PathStep[][] = [];
  const walk = (node: Node, path: PathStep[]): void => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text.length > 0 && text.toLowerCase().includes(needle)) {
        const parent = node.parentElement;
        if (parent && isVisibleElement(parent)) {
          paths.push(path);
        }
      }
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    if (ignoredTags.has(el.tagName.toLowerCase())) {
      return;
    }
    const children = Array.from(el.childNodes);
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (child.nodeType === 3) {
        walk(child, path);
      } else {
        walk(child, [...path, { kind: "child", index }]);
      }
    }
    if (el.shadowRoot) {
      const shadowChildren = Array.from(el.shadowRoot.childNodes);
      for (let index = 0; index < shadowChildren.length; index++) {
        const child = shadowChildren[index];
        if (child.nodeType === 3) {
          walk(child, [...path, { kind: "shadow" }]);
        } else {
          walk(child, [...path, { kind: "shadow" }, { kind: "child", index }]);
        }
      }
    }
  };
  walk(document.body, []);
  return paths;
}

function resolveElementAtPath(path: PathStep[]): Element | null {
  let node: Node | null = document.body;
  for (const step of path) {
    if (step.kind === "shadow") {
      node = node instanceof Element ? node.shadowRoot : null;
    } else {
      node = node?.childNodes.item(step.index) ?? null;
    }
  }
  return node instanceof Element ? node : null;
}