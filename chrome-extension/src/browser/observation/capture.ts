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
  captureId?: string;
}

export const OVERLAY_CLASS = "astra-obs-overlay";
export const TARGET_CLASS = "astra-obs-target";
export const BADGE_CLASS = "astra-obs-badge";
export const CAPTURE_ATTRIBUTE = "data-astra-observation";

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

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

export function clipToRect(bounds: RectBounds, rect: RectBounds): RectBounds | null {
  const x = Math.max(rect.x, bounds.x);
  const y = Math.max(rect.y, bounds.y);
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
  if (right <= x || bottom <= y) {
    return null;
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function clipToViewport(bounds: RectBounds, width: number, height: number): RectBounds | null {
  return clipToRect(bounds, { x: 0, y: 0, width, height });
}

export function buildHighlightOverlay(
  doc: Document,
  refs: ObservedRef[],
  viewport: ViewportMeasurements,
  captureId = "default",
): HTMLElement {
  const style = doc.createElement("style");
  style.textContent = OVERLAY_CSS;

  const overlay = doc.createElement("div");
  overlay.className = OVERLAY_CLASS;
  overlay.setAttribute(CAPTURE_ATTRIBUTE, captureId);
  overlay.appendChild(style);
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

  doc.documentElement.appendChild(overlay);
  return overlay;
}

export function removeHighlightOverlay(doc: Document, captureId = "default"): void {
  for (const node of doc.querySelectorAll(`[${CAPTURE_ATTRIBUTE}]`)) {
    if (node.getAttribute(CAPTURE_ATTRIBUTE) === captureId) {
      node.remove();
    }
  }
}

export async function captureHighlightedViewport(options: CaptureOptions): Promise<ViewportCapture> {
  const { refs, viewport, captureScreenshot, document: doc, captureId = "default" } = options;

  try {
    buildHighlightOverlay(doc, refs, viewport, captureId);
    const data = await captureScreenshot();
    const dimensions = readJpegDimensions(data);
    if (!dimensions) {
      throw new Error("Screenshot did not contain valid JPEG dimensions");
    }
    return { data, mimeType: "image/jpeg", ...dimensions };
  } finally {
    removeHighlightOverlay(doc, captureId);
  }
}

export function readJpegDimensions(base64: string): { width: number; height: number } | null {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  const byte = (index: number): number => binary.charCodeAt(index);
  if (binary.length < 4 || byte(0) !== 0xff || byte(1) !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < binary.length) {
    while (offset < binary.length && byte(offset) !== 0xff) offset += 1;
    while (offset < binary.length && byte(offset) === 0xff) offset += 1;
    if (offset >= binary.length) return null;

    const marker = byte(offset);
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= binary.length) return null;

    const segmentLength = (byte(offset) << 8) | byte(offset + 1);
    if (segmentLength < 2 || offset + segmentLength > binary.length) return null;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = (byte(offset + 3) << 8) | byte(offset + 4);
      const width = (byte(offset + 5) << 8) | byte(offset + 6);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
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
