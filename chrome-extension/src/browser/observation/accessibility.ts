import type { ExtractedElement, ExtractedPageContent } from "./types";

export interface SerializableAXNode {
  role: string;
  name?: string;
  value?: string | number;
  description?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  backendNodeId?: number;
  children?: SerializableAXNode[];
}

export interface FlatAXNode {
  role: string;
  name?: string;
}

const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "gridcell",
  "link",
  "listbox",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "tree",
  "treeitem",
]);

export const IGNORED_TEXT_TAGS = new Set(["script", "style", "svg", "template", "noscript"]);

export function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function computeRole(el: Element): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) {
    return explicit;
  }
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return el.hasAttribute("href") ? "link" : null;
    case "button":
    case "summary":
      return "button";
    case "input":
      return inputRole(el.getAttribute("type")?.toLowerCase() ?? null);
    case "select":
      return "combobox";
    case "option":
      return "option";
    case "textarea":
      return "textbox";
    default:
      return null;
  }
}

export function inputRole(type: string | null): string {
  switch (type) {
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    case "range":
      return "slider";
    case "search":
      return "searchbox";
    case "number":
      return "spinbutton";
    default:
      return "textbox";
  }
}

export function computeAccessibleName(win: Window, el: Element): string | null {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const parts = labelledby
      .split(/\s+/)
      .map((id) => win.document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null)
      .map((node) => descendantText(node))
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) {
    return collapse(ariaLabel);
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const label = associatedLabel(win, el);
    if (label) {
      const text = descendantText(label);
      if (text) {
        return text;
      }
    }
    if (tag === "input") {
      const type = el.getAttribute("type")?.toLowerCase();
      if (type === "image") {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) {
          return collapse(alt);
        }
      }
      if (type === "button" || type === "submit" || type === "reset") {
        const value = (el as HTMLInputElement).value;
        if (value) {
          return collapse(value);
        }
      }
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) {
      return collapse(title);
    }
    return null;
  }

  const text = descendantText(el);
  if (text) {
    return text;
  }
  const title = el.getAttribute("title");
  if (title && title.trim()) {
    return collapse(title);
  }
  return null;
}

export function associatedLabel(win: Window, el: Element): Element | null {
  const id = el.id;
  if (id) {
    const labels = Array.from(win.document.querySelectorAll("label"));
    const label = labels.find((label) => label.getAttribute("for") === id);
    if (label) {
      return label;
    }
  }
  return el.closest("label");
}

export function descendantText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = collapse(node.textContent ?? "");
      if (text) {
        parts.push(text);
      }
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (IGNORED_TEXT_TAGS.has(tag)) {
      return;
    }
    if (tag === "img" || (tag === "input" && el.getAttribute("type") === "image")) {
      const alt = el.getAttribute("alt");
      if (alt && alt.trim()) {
        parts.push(collapse(alt));
      }
      return;
    }
    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
  };
  for (const child of Array.from(root.childNodes)) {
    walk(child);
  }
  return parts.join(" ").trim();
}

export function flattenAXTree(nodes: SerializableAXNode[]): FlatAXNode[] {
  const out: FlatAXNode[] = [];
  const walk = (node: SerializableAXNode): void => {
    if (CONTROL_ROLES.has(node.role)) {
      out.push({ role: node.role, name: node.name });
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  for (const node of nodes) {
    walk(node);
  }
  return out;
}

export async function enrichPageContentWithAccessibility(
  content: ExtractedPageContent,
  resolveControl: (control: ExtractedElement) => Promise<SerializableAXNode | null>,
): Promise<ExtractedPageContent> {
  for (const control of content.controls) {
    const node = await resolveControl(control);
    if (node) {
      applyAXNode(control, node);
    }
  }
  return content;
}

function applyAXNode(control: ExtractedElement, ax: FlatAXNode): void {
  if (ax.role && CONTROL_ROLES.has(ax.role)) {
    control.role = ax.role;
  }
  if (ax.name && ax.name.trim()) {
    control.name = ax.name.trim();
  }
}
