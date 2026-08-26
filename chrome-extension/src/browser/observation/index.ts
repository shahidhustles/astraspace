import {
  associatedLabel,
  collapse,
  computeAccessibleName,
  computeRole,
  descendantText,
  enrichPageContentWithAccessibility,
  IGNORED_TEXT_TAGS,
  inputRole,
} from "./accessibility";
import {
  ATTR_ALLOWLIST,
  collectAttrs,
  EDGE_EPSILON,
  ELEMENT_NODE,
  extractFrameContent,
  extractPageContent,
  IGNORED_TAGS,
  INTERACTIVE_ROLES,
  INTERACTIVE_TAGS,
  isDisabled,
  isInteractiveElement,
  isOffscreen,
  isSensitiveControl,
  locatorSegments,
  measureViewport,
  rectOf,
  sensitiveName,
  SHADOW_ROOT_NODE,
  TEXT_NODE,
  visitElement,
  visitNode,
  type OwnerMap,
} from "./extract";
import {
  BADGE_CLASS,
  buildHighlightOverlay,
  buildLabel,
  CAPTURE_ATTRIBUTE,
  clipToRect,
  clipToViewport,
  OVERLAY_CLASS,
  OVERLAY_CSS,
  readJpegDimensions,
  removeHighlightOverlay,
  TARGET_CLASS,
} from "./capture";
import { renderPageContent, toObservedRef } from "./render";
import type { ObservedRef, ViewportMeasurements } from "./types";

export { enrichPageContentWithAccessibility, readJpegDimensions, renderPageContent, toObservedRef };
export { clipToRect } from "./capture";
export type {
  CommittedGroundingRecord,
  CommittedObservedRef,
  ExtractedFrame,
  ExtractedFrameContent,
  ExtractedNode,
  ExtractedPageContent,
  FrameLineageStep,
  GroundingRecord,
  ObservedRef,
  PathStep,
  RectBounds,
  ScrollState,
  ViewportCapture,
  ViewportMeasurements,
} from "./types";

function setSource(name: string, values: Iterable<string>): string {
  return `const ${name} = new Set(${JSON.stringify([...values])});`;
}

const EXTRACT_PREAMBLE = [
  setSource("IGNORED_TAGS", IGNORED_TAGS),
  setSource("INTERACTIVE_TAGS", INTERACTIVE_TAGS),
  setSource("INTERACTIVE_ROLES", INTERACTIVE_ROLES),
  setSource("ATTR_ALLOWLIST", ATTR_ALLOWLIST),
  setSource("IGNORED_TEXT_TAGS", IGNORED_TEXT_TAGS),
  `const EDGE_EPSILON = ${EDGE_EPSILON};`,
  `const TEXT_NODE = ${TEXT_NODE};`,
  `const ELEMENT_NODE = ${ELEMENT_NODE};`,
  `const SHADOW_ROOT_NODE = ${SHADOW_ROOT_NODE};`,
  computeRole.toString(),
  inputRole.toString(),
  collapse.toString(),
  computeAccessibleName.toString(),
  associatedLabel.toString(),
  descendantText.toString(),
  extractPageContent.toString(),
  extractFrameContent.toString(),
  visitNode.toString(),
  visitElement.toString(),
  locatorSegments.toString(),
  rectOf.toString(),
  isOffscreen.toString(),
  isInteractiveElement.toString(),
  isDisabled.toString(),
  isSensitiveControl.toString(),
  sensitiveName.toString(),
  collectAttrs.toString(),
  measureViewport.toString(),
].join("\n");

const OVERLAY_PREAMBLE = [
  `const OVERLAY_CLASS = ${JSON.stringify(OVERLAY_CLASS)};`,
  `const TARGET_CLASS = ${JSON.stringify(TARGET_CLASS)};`,
  `const BADGE_CLASS = ${JSON.stringify(BADGE_CLASS)};`,
  `const CAPTURE_ATTRIBUTE = ${JSON.stringify(CAPTURE_ATTRIBUTE)};`,
  `const OVERLAY_CSS = ${JSON.stringify(OVERLAY_CSS)};`,
  clipToRect.toString(),
  clipToViewport.toString(),
  buildLabel.toString(),
  buildHighlightOverlay.toString(),
  removeHighlightOverlay.toString(),
].join("\n");

export const OBSERVE_PAGE_SOURCE = `(win, startRef, owners) => {
${EXTRACT_PREAMBLE}
return extractFrameContent(win, startRef, owners);
}`;

export const BUILD_HIGHLIGHT_OVERLAY_SOURCE = `(doc, refs, viewport, captureId) => {
${OVERLAY_PREAMBLE}
buildHighlightOverlay(doc, refs, viewport, captureId);
}`;

export const REMOVE_HIGHLIGHT_OVERLAY_SOURCE = `(doc, captureId) => {
${OVERLAY_PREAMBLE}
removeHighlightOverlay(doc, captureId);
}`;

export function observePageExpression(startRef = 1, owners: OwnerMap = {}): string {
  return `(${OBSERVE_PAGE_SOURCE})(window, ${startRef}, ${JSON.stringify(owners)})`;
}

export function buildHighlightOverlayExpression(
  refs: ObservedRef[],
  viewport: ViewportMeasurements,
  captureId: string,
): string {
  return `(${BUILD_HIGHLIGHT_OVERLAY_SOURCE})(document, ${JSON.stringify(refs)}, ${JSON.stringify(viewport)}, ${JSON.stringify(captureId)})`;
}

export function removeHighlightOverlayExpression(captureId: string): string {
  return `(${REMOVE_HIGHLIGHT_OVERLAY_SOURCE})(document, ${JSON.stringify(captureId)})`;
}
