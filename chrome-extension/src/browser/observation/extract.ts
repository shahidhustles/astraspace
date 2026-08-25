import type {
  ExtractedElement,
  ExtractedNode,
  ExtractedPageContent,
  RectBounds,
  ViewportMeasurements,
} from "./types";

const IGNORED_TAGS = new Set([
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

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "option",
]);

const INTERACTIVE_ROLES = new Set([
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

const ATTR_ALLOWLIST = new Set([
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

const EDGE_EPSILON = 1;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export function extractPageContent(win: Window): ExtractedPageContent {
  const viewport = measureViewport(win);
  const controls: ExtractedElement[] = [];
  const refCounter = { next: 1 };
  const rootChildren: ExtractedNode[] = [];

  const body = win.document.body;
  if (body) {
    for (const child of Array.from(body.childNodes)) {
      const node = visitNode(child, win, viewport, controls, refCounter, false);
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
      attrs: {},
      interactive: false,
      disabled: false,
      bounds: null,
      ref: null,
      children: rootChildren,
    },
    controls,
    viewport,
  };
}

function visitNode(
  node: Node,
  win: Window,
  viewport: ViewportMeasurements,
  controls: ExtractedElement[],
  refCounter: { next: number },
  insideActionable: boolean,
): ExtractedNode | null {
  if (node.nodeType === TEXT_NODE) {
    const text = node.textContent?.trim() ?? "";
    return text ? { kind: "text", text } : null;
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return null;
  }
  return visitElement(node as Element, win, viewport, controls, refCounter, insideActionable);
}

function visitElement(
  el: Element,
  win: Window,
  viewport: ViewportMeasurements,
  controls: ExtractedElement[],
  refCounter: { next: number },
  insideActionable: boolean,
): ExtractedElement | null {
  const tag = el.tagName.toLowerCase();
  if (IGNORED_TAGS.has(tag) || tag === "iframe") {
    return null;
  }
  if (el.shadowRoot) {
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
    if (isOffscreen(bounds, viewport, style)) {
      return null;
    }
  }

  const interactive = isInteractiveElement(el);
  const disabled = interactive && isDisabled(el);
  const actionable = interactive && !disabled && !insideActionable;
  const node: ExtractedElement = {
    kind: "element",
    tag,
    role: el.getAttribute("role"),
    attrs: collectAttrs(el, tag),
    interactive,
    disabled,
    bounds,
    ref: actionable ? refCounter.next++ : null,
    children: [],
  };
  if (interactive) {
    controls.push(node);
  }

  const childInsideActionable = insideActionable || actionable;
  for (const child of Array.from(el.childNodes)) {
    const childNode = visitNode(child, win, viewport, controls, refCounter, childInsideActionable);
    if (childNode) {
      node.children.push(childNode);
    }
  }
  return node;
}

function rectOf(el: Element): RectBounds | null {
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

function isOffscreen(bounds: RectBounds, viewport: ViewportMeasurements, style: CSSStyleDeclaration): boolean {
  if (style.position === "fixed" || style.position === "sticky") {
    return false;
  }
  const { width, height } = viewport;
  return (
    bounds.x + bounds.width <= 0 ||
    bounds.y + bounds.height <= 0 ||
    bounds.x >= width ||
    bounds.y >= height
  );
}

function isInteractiveElement(el: Element): boolean {
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
  if (el.getAttribute("contenteditable") !== null || (el as HTMLElement).isContentEditable) {
    return true;
  }
  const tabindex = el.getAttribute("tabindex");
  if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) {
    return true;
  }
  return el.hasAttribute("onclick");
}

function isDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true" || el.hasAttribute("disabled")) {
    return true;
  }
  return (el as Element & { disabled?: boolean }).disabled === true;
}

function collectAttrs(el: Element, tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const name of ATTR_ALLOWLIST) {
    if (el.hasAttribute(name)) {
      attrs[name] = el.getAttribute(name) as string;
    }
  }

  const type = el.getAttribute("type")?.toLowerCase();
  if (tag === "input") {
    if (type === "checkbox" || type === "radio") {
      attrs.checked = String((el as HTMLInputElement).checked);
    } else if (type !== "password") {
      const value = (el as HTMLInputElement).value;
      if (value !== "") {
        attrs.value = value;
      }
    }
  } else if (tag === "textarea") {
    const value = (el as HTMLTextAreaElement).value;
    if (value !== "") {
      attrs.value = value;
    }
  } else if (tag === "select") {
    const value = (el as HTMLSelectElement).value;
    if (value !== "") {
      attrs.value = value;
    }
  } else if (tag === "option" && (el as HTMLOptionElement).selected) {
    attrs.selected = "true";
  }
  return attrs;
}

function measureViewport(win: Window): ViewportMeasurements {
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
