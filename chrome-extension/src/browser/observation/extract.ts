import type {
  ExtractedElement,
  ExtractedFrame,
  ExtractedFrameContent,
  ExtractedNode,
  ExtractedPageContent,
  PathStep,
  RectBounds,
  ViewportMeasurements,
} from "./types";
import { collapse, computeAccessibleName, computeRole, descendantText } from "./accessibility";

export const IGNORED_TAGS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "noscript",
  "template",
  "title",
  "head",
  "svg",
]);

export const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "option",
]);

export const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export const ATTR_ALLOWLIST = new Set([
  "aria-checked",
  "aria-expanded",
  "aria-haspopup",
  "aria-label",
  "aria-selected",
  "alt",
  "href",
  "name",
  "placeholder",
  "target",
  "title",
  "type",
]);

export const EDGE_EPSILON = 1;
export const TEXT_NODE = 3;
export const ELEMENT_NODE = 1;
export const SHADOW_ROOT_NODE = 11;

export type OwnerMap = Record<string, string>;

export function extractPageContent(
  win: Window,
  startRef = 1,
  owners: OwnerMap = {},
): ExtractedPageContent {
  const viewport = measureViewport(win);
  const controls: ExtractedElement[] = [];
  const refCounter = { next: startRef };
  const rootChildren: ExtractedNode[] = [];

  const body = win.document.body;
  if (body) {
    for (const [index, child] of Array.from(body.childNodes).entries()) {
      const node = visitNode(
        child,
        win,
        viewport,
        controls,
        refCounter,
        false,
        [{ kind: "child", index }],
        owners,
      );
      if (node) {
        rootChildren.push(node);
      }
    }
  }

  return {
    root: {
      kind: "element",
      tag: "document",
      role: null,
      name: null,
      attrs: {},
      interactive: false,
      disabled: false,
      bounds: null,
      ref: null,
      domPath: [],
      frameLineage: [],
      backendNodeId: null,
      cssSegments: [],
      xpathSegments: [],
      text: null,
      children: rootChildren,
    },
    controls,
    viewport,
  };
}

export function extractFrameContent(
  win: Window,
  startRef = 1,
  owners: OwnerMap = {},
): ExtractedFrameContent {
  const content = extractPageContent(win, startRef, owners);
  const allocated = content.controls.filter((control) => control.ref !== null).length;
  return { content, nextRef: startRef + allocated };
}

export function visitNode(
  node: Node,
  win: Window,
  viewport: ViewportMeasurements,
  controls: ExtractedElement[],
  refCounter: { next: number },
  insideActionable: boolean,
  domPath: PathStep[],
  owners: OwnerMap,
): ExtractedNode | null {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent?.trim() ?? "";
    return text ? { kind: "text", text } : null;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return null;
  }
  return visitElement(node as Element, win, viewport, controls, refCounter, insideActionable, domPath, owners);
}

export function visitElement(
  el: Element,
  win: Window,
  viewport: ViewportMeasurements,
  controls: ExtractedElement[],
  refCounter: { next: number },
  insideActionable: boolean,
  domPath: PathStep[],
  owners: OwnerMap,
): ExtractedElement | ExtractedFrame | null {
  const tag = el.tagName.toLowerCase();
  if (IGNORED_TAGS.has(tag)) {
    return null;
  }
  if (tag === "input" && el.getAttribute("type") === "hidden") {
    return null;
  }

  const style = win.getComputedStyle(el);
  if (style.display === "none" || style.opacity === "0" || style.visibility === "hidden") {
    return null;
  }
  if (el.hasAttribute("hidden") || el.closest("[inert]")) {
    return null;
  }

  let bounds: RectBounds | null = null;
  if (tag !== "option") {
    bounds = rectOf(el);
    if (!bounds) {
      return null;
    }
    if (isOffscreen(bounds, viewport)) {
      return null;
    }
  }

  if (tag === "iframe") {
    return { kind: "frame", frameId: owners[JSON.stringify(domPath)] ?? null, children: [] };
  }

  const opaqueCustomElement = tag.includes("-") && el.shadowRoot === null;
  const interactive = !opaqueCustomElement && isInteractiveElement(el, style);
  const disabled = interactive && isDisabled(el);
  const actionable = interactive && !disabled && !insideActionable;
  const sensitive = isSensitiveControl(el, tag);
  const computedName = interactive ? computeAccessibleName(win, el) : null;
  const locators = actionable ? locatorSegments(el, win.document) : null;
  const node: ExtractedElement = {
    kind: "element",
    tag,
    role: computeRole(el),
    name: sensitive && sensitiveName(el, computedName) ? null : computedName,
    attrs: collectAttrs(el, tag, sensitive),
    interactive,
    disabled,
    bounds,
    ref: actionable ? refCounter.next++ : null,
    domPath,
    frameLineage: [],
    backendNodeId: null,
    cssSegments: locators?.css ?? [],
    xpathSegments: locators?.xpath ?? [],
    text: actionable ? (sensitive ? null : collapse(descendantText(el)) || null) : null,
    children: [],
  };
  if (interactive) {
    controls.push(node);
  }

  const childInsideActionable = insideActionable || actionable;
  if (!sensitive) {
    for (const [index, child] of Array.from(el.childNodes).entries()) {
      const childNode = visitNode(
        child,
        win,
        viewport,
        controls,
        refCounter,
        childInsideActionable,
        [...domPath, { kind: "child", index }],
        owners,
      );
      if (childNode) {
        node.children.push(childNode);
      }
    }
    const shadowRoot = el.shadowRoot;
    if (shadowRoot) {
      const shadowChildren: ExtractedNode[] = [];
      for (const [index, child] of Array.from(shadowRoot.childNodes).entries()) {
        const childNode = visitNode(
          child,
          win,
          viewport,
          controls,
          refCounter,
          childInsideActionable,
          [...domPath, { kind: "shadow" }, { kind: "child", index }],
          owners,
        );
        if (childNode) {
          shadowChildren.push(childNode);
        }
      }
      if (shadowChildren.length > 0) {
        node.children.push({ kind: "shadow", children: shadowChildren });
      }
    }
  }
  return node;
}

export function sensitiveName(el: Element, name: string | null): boolean {
  if (!name) {
    return false;
  }
  const normalizedName = collapse(name);
  const unsafeSources = [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("title") ?? "",
    "value" in el && typeof el.value === "string" ? el.value : "",
  ];
  return unsafeSources.some((source) => {
    const normalizedSource = collapse(source);
    return normalizedSource.length > 0 && (
      normalizedName === normalizedSource ||
      (normalizedSource.length >= 3 && normalizedName.includes(normalizedSource))
    );
  });
}

export function locatorSegments(el: Element, doc: Document): { css: string[]; xpath: string[] } {
  const css: string[][] = [[]];
  const xpath: string[][] = [[]];
  let node: Node | null = el;
  while (node && node !== doc.body) {
    const parent: Node | null = node.parentNode;
    if (!parent || (parent.nodeType !== ELEMENT_NODE && parent.nodeType !== SHADOW_ROOT_NODE)) {
      return { css: [], xpath: [] };
    }
    const tag = (node as Element).tagName.toLowerCase();
    const elementPosition =
      Array.from(parent.childNodes)
        .filter((child) => child.nodeType === ELEMENT_NODE)
        .indexOf(node as ChildNode) + 1;
    if (elementPosition < 1) {
      return { css: [], xpath: [] };
    }
    css[css.length - 1].push(`${tag}:nth-child(${elementPosition})`);
    xpath[xpath.length - 1].push(`/${tag}[${elementPosition}]`);
    if (parent.nodeType === SHADOW_ROOT_NODE) {
      css.push([]);
      xpath.push([]);
      node = (parent as ShadowRoot).host;
    } else {
      node = parent;
    }
  }
  return {
    css: css.reverse().map((segment) => segment.reverse().join(" > ")),
    xpath: xpath.reverse().map((segment) => segment.reverse().join("")),
  };
}

export function rectOf(el: Element): RectBounds | null {
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: Math.round(rect.x ?? rect.left),
    y: Math.round(rect.y ?? rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function isOffscreen(bounds: RectBounds, viewport: ViewportMeasurements): boolean {
  const { width, height } = viewport;
  return (
    bounds.x + bounds.width <= 0 ||
    bounds.y + bounds.height <= 0 ||
    bounds.x >= width ||
    bounds.y >= height
  );
}

export function isInteractiveElement(el: Element, style?: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) {
    if (tag === "a") {
      return el.hasAttribute("href");
    }
    return true;
  }
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) {
    return true;
  }
  const contenteditable = el.getAttribute("contenteditable")?.toLowerCase();
  if (
    (el as HTMLElement).isContentEditable ||
    contenteditable === "" ||
    contenteditable === "true" ||
    contenteditable === "plaintext-only"
  ) {
    return true;
  }
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) {
    return true;
  }
  if (el.hasAttribute("onclick") || typeof (el as HTMLElement).onclick === "function") {
    return true;
  }
  return style?.cursor === "pointer";
}

export function isDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) {
    return true;
  }
  return (el as Element & { disabled?: boolean }).disabled === true;
}

export function isSensitiveControl(el: Element, tag = el.tagName.toLowerCase()): boolean {
  if (tag !== "input" && tag !== "textarea" && tag !== "select") {
    return false;
  }
  const type = el.getAttribute("type")?.toLowerCase() ?? "";
  if (type === "password" || type === "hidden") {
    return true;
  }
  const autocomplete = (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/);
  const sensitiveAutocomplete = new Set([
    "current-password",
    "new-password",
    "one-time-code",
    "cc-number",
    "cc-csc",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
  ]);
  if (autocomplete.some((token) => sensitiveAutocomplete.has(token))) {
    return true;
  }
  const signals = [
    el.id,
    el.getAttribute("name") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("placeholder") ?? "",
  ].join(" ");
  return /(?:password|passwd|passcode|\bpin\b|\botp\b|one[ _-]?time|token|secret|api[ _-]?key|cvv|cvc|card[ _-]?number|credit[ _-]?card|ssn|social[ _-]?security|recovery[ _-]?code|auth[ _-]?code)/i.test(signals);
}

export function collectAttrs(el: Element, tag: string, sensitive = isSensitiveControl(el, tag)): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of ATTR_ALLOWLIST) {
    if (sensitive && name !== "type") {
      continue;
    }
    if (el.hasAttribute(name)) {
      attrs[name] = el.getAttribute(name) as string;
    }
  }

  const type = el.getAttribute("type")?.toLowerCase();
  if (tag === "input") {
    if (type === "checkbox" || type === "radio") {
      attrs.checked = String((el as HTMLInputElement).checked);
    } else if (!sensitive) {
      const value = (el as HTMLInputElement).value;
      if (value !== "") {
        attrs.value = value;
      }
    }
  } else if (tag === "textarea" && !sensitive) {
    const value = (el as HTMLTextAreaElement).value;
    if (value !== "") {
      attrs.value = value;
    }
  } else if (tag === "select" && !sensitive) {
    const value = (el as HTMLSelectElement).value;
    if (value !== "") {
      attrs.value = value;
    }
  } else if (tag === "option" && (el as HTMLOptionElement).selected) {
    attrs.selected = "true";
  }
  return attrs;
}

export function measureViewport(win: Window): ViewportMeasurements {
  const doc = win.document;
  const documentElement = doc.documentElement;
  const width = win.innerWidth || documentElement?.clientWidth || 0;
  const height = win.innerHeight || documentElement?.clientHeight || 0;
  const scrollX = win.scrollX ?? documentElement?.scrollLeft ?? 0;
  const scrollY = win.scrollY ?? documentElement?.scrollTop ?? 0;
  const documentWidth = Math.max(documentElement?.scrollWidth ?? 0, doc.body?.scrollWidth ?? 0);
  const documentHeight = Math.max(documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
  const maxX = Math.max(0, documentWidth - width);
  const maxY = Math.max(0, documentHeight - height);

  return {
    bounds: { x: 0, y: 0, width, height },
    width,
    height,
    documentWidth,
    documentHeight,
    scroll: {
      x: scrollX,
      y: scrollY,
      maxX,
      maxY,
      atTop: scrollY <= EDGE_EPSILON,
      atBottom: scrollY >= maxY - EDGE_EPSILON,
      atLeft: scrollX <= EDGE_EPSILON,
      atRight: scrollX >= maxX - EDGE_EPSILON,
    },
  };
}
