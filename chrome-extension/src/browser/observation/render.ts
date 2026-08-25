import type {
  ExtractedElement,
  ExtractedNode,
  ExtractedPageContent,
  ObservedRef,
  RenderedPageContent,
} from "./types";
import { INTERACTIVE_ROLES } from "./extract";

const STRUCTURAL_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "label",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const TEXT_ATTRIBUTES = new Set(["aria-label", "placeholder", "title", "alt"]);

const ATTR_ORDER = new Map([
  ["type", 0],
  ["name", 1],
  ["value", 2],
  ["placeholder", 3],
  ["checked", 4],
  ["selected", 5],
  ["href", 6],
  ["alt", 7],
  ["target", 8],
  ["title", 9],
  ["aria-label", 10],
]);

export function renderPageContent(content: ExtractedPageContent): RenderedPageContent {
  const lines: string[] = [];
  const refs: ObservedRef[] = [];
  lines.push("<document>");
  for (const child of content.root.children) {
    renderNode(child, 1, false, lines, refs);
  }
  return { dom: lines.join("\n"), refs };
}

function renderNode(
  node: ExtractedNode,
  depth: number,
  textOwned: boolean,
  lines: string[],
  refs: ObservedRef[],
): void {
  if (node.kind === "text") {
    if (!textOwned && node.text) {
      lines.push(`${"  ".repeat(depth)}${escapeSemanticText(node.text)}`);
    }
    return;
  }

  const el = node;
  if (el.ref !== null) {
    lines.push(`${"  ".repeat(depth)}${formatActionable(el)}`);
    refs.push(toObservedRef(el));
    for (const child of el.children) {
      renderNode(child, depth + 1, true, lines, refs);
    }
    return;
  }

  if (isStructural(el)) {
    lines.push(`${"  ".repeat(depth)}${formatElement(el)}`);
    for (const child of el.children) {
      renderNode(child, depth + 1, true, lines, refs);
    }
    return;
  }

  for (const child of el.children) {
    renderNode(child, depth, textOwned, lines, refs);
  }
}

function formatActionable(el: ExtractedElement): string {
  const attrs = renderAttrs(el);
  const text = el.name ?? ownedText(el);
  let line = `[${el.ref}]<${el.tag}`;
  if (attrs) {
    line += ` ${attrs}`;
  }
  if (text) {
    line += `>${escapeSemanticText(text)}`;
  }
  return `${line} />`;
}

function formatElement(el: ExtractedElement): string {
  const attrs = renderAttrs(el);
  const text = ownedText(el);
  let line = `<${el.tag}`;
  if (attrs) {
    line += ` ${attrs}`;
  }
  line += text ? `>${escapeSemanticText(text)}` : ">";
  return line;
}

function renderAttrs(el: ExtractedElement): string {
  const text = el.name ?? ownedText(el);
  const parts: string[] = [];
  if (el.role && el.role !== el.tag) {
    parts.push(`role=${formatAttributeValue(el.role)}`);
  }
  const seen = new Set<string>();
  const entries = Object.entries(el.attrs).sort((a, b) => {
    const rankA = ATTR_ORDER.get(a[0]) ?? 100;
    const rankB = ATTR_ORDER.get(b[0]) ?? 100;
    return rankA - rankB;
  });
  for (const [key, raw] of entries) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (TEXT_ATTRIBUTES.has(key) && value.toLowerCase() === text.toLowerCase()) {
      continue;
    }
    if (value.length > 5) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
    }
    parts.push(value === "true" ? key : `${key}=${formatAttributeValue(value)}`);
  }
  if (el.disabled) {
    parts.push("disabled");
  }
  return parts.join(" ");
}

function escapeSemanticText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\[/g, "\\u005b")
    .replace(/\]/g, "\\u005d")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function formatAttributeValue(value: string): string {
  const escaped = escapeSemanticText(value);
  return /^[A-Za-z0-9._:/?&=#%-]+$/.test(escaped) ? escaped : JSON.stringify(escaped);
}

function ownedText(el: ExtractedElement): string {
  const parts: string[] = [];
  for (const child of el.children) {
    if (child.kind === "text") {
      parts.push(child.text.replace(/\s+/g, " "));
    } else if (!isStructural(child) && child.ref === null) {
      parts.push(ownedText(child));
    }
  }
  return parts.join(" ").trim();
}

function isStructural(el: ExtractedElement): boolean {
  return (
    STRUCTURAL_TAGS.has(el.tag) ||
    el.disabled ||
    (el.role !== null && !INTERACTIVE_ROLES.has(el.role))
  );
}

function toObservedRef(el: ExtractedElement): ObservedRef {
  return {
    ref: el.ref as number,
    tag: el.tag,
    role: el.role,
    name: el.name,
    attrs: el.attrs,
    bounds: el.bounds,
  };
}
