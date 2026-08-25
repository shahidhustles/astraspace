import type {
  ObservedRef,
  RectBounds,
  ViewportCapture,
  ViewportMeasurements,
} from "./types";

export interface CaptureOptions {
  refs: ObservedRef[];
  viewport: ViewportMeasurements;
  captureScreenshot: () => Promise<string>;
  document: Document;
}

export const OVERLAY_CLASS = "astra-obs-overlay";
export const TARGET_CLASS = "astra-obs-target";
export const BADGE_CLASS = "astra-obs-badge";
export const STYLE_ID = "astra-obs-style";

export const OVERLAY_CSS = `
.${OVERLAY_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
}
.${TARGET_CLASS} {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #22d3ee;
  background: rgba(34, 211, 238, 0.18);
}
.${BADGE_CLASS} {
  position: absolute;
  top: 2px;
  left: 2px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: #22d3ee;
  color: #0b1220;
  font: 700 12px/18px ui-sans-serif, system-ui, sans-serif;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}
`;

export function clipToViewport(bounds: RectBounds, width: number, height: number): RectBounds | null {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const right = Math.min(width, bounds.x + bounds.width);
  const bottom = Math.min(height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function buildHighlightOverlay(
  doc: Document,
  refs: ObservedRef[],
  viewport: ViewportMeasurements,
): HTMLElement {
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = OVERLAY_CSS;

  const overlay = doc.createElement("div");
  overlay.className = OVERLAY_CLASS;
  for (const ref of refs) {
    if (!ref.bounds) {
      continue;
    }
    const clipped = clipToViewport(ref.bounds, viewport.width, viewport.height);
    if (!clipped) {
      continue;
    }
    overlay.appendChild(buildLabel(doc, ref.ref, clipped));
  }

  doc.documentElement.appendChild(style);
  doc.documentElement.appendChild(overlay);
  return overlay;
}

export function removeHighlightOverlay(doc: Document): void {
  doc.getElementById(STYLE_ID)?.remove();
  for (const node of doc.querySelectorAll(`.${OVERLAY_CLASS}, .${TARGET_CLASS}, .${BADGE_CLASS}`)) {
    node.remove();
  }
}

export async function captureHighlightedViewport(options: CaptureOptions): Promise<ViewportCapture> {
  const { refs, viewport, captureScreenshot, document: doc } = options;

  buildHighlightOverlay(doc, refs, viewport);
  try {
    const data = await captureScreenshot();
    return { data, mimeType: "image/jpeg", width: viewport.width, height: viewport.height };
  } finally {
    removeHighlightOverlay(doc);
  }
}

export function buildLabel(doc: Document, ref: number, bounds: RectBounds): HTMLElement {
  const target = doc.createElement("div");
  target.className = TARGET_CLASS;
  target.dataset.ref = String(ref);
  target.style.left = `${bounds.x}px`;
  target.style.top = `${bounds.y}px`;
  target.style.width = `${bounds.width}px`;
  target.style.height = `${bounds.height}px`;

  const badge = doc.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = String(ref);
  target.appendChild(badge);
  return target;
}