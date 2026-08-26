export interface RectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScrollState {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  atTop: boolean;
  atBottom: boolean;
  atLeft: boolean;
  atRight: boolean;
}

export interface ViewportMeasurements {
  bounds: RectBounds;
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  scroll: ScrollState;
}

export type PathStep = { kind: "child"; index: number } | { kind: "shadow" };

export interface FrameLineageStep {
  frameId: string;
  parentFrameId: string | null;
  documentEpoch: number;
  navigationEpoch: number;
}

export interface ExtractedText {
  kind: "text";
  text: string;
}

export interface ExtractedElement {
  kind: "element";
  tag: string;
  role: string | null;
  name: string | null;
  attrs: Record<string, string>;
  interactive: boolean;
  disabled: boolean;
  bounds: RectBounds | null;
  ref: number | null;
  domPath: PathStep[];
  frameLineage: FrameLineageStep[];
  backendNodeId: number | null;
  cssSegments: string[];
  xpathSegments: string[];
  text: string | null;
  children: ExtractedNode[];
}

export interface ExtractedFrame {
  kind: "frame";
  frameId: string | null;
  children: ExtractedNode[];
}

export interface ExtractedShadowRoot {
  kind: "shadow";
  children: ExtractedNode[];
}

export type ExtractedNode = ExtractedText | ExtractedElement | ExtractedFrame | ExtractedShadowRoot;

export interface ExtractedPageContent {
  root: ExtractedElement;
  controls: ExtractedElement[];
  viewport: ViewportMeasurements;
}

export interface ExtractedFrameContent {
  content: ExtractedPageContent;
  nextRef: number;
}

export interface ObservedRef {
  ref: number;
  tag: string;
  role: string | null;
  name: string | null;
  attrs: Record<string, string>;
  bounds: RectBounds | null;
}

export interface GroundingRecord {
  ref: number;
  domPath: PathStep[];
  frameLineage: FrameLineageStep[];
  backendNodeId: number | null;
  cssSegments: string[];
  xpathSegments: string[];
  text: string | null;
  tag: string;
  role: string | null;
  name: string | null;
  attrs: Record<string, string>;
  disabled: boolean;
  bounds: RectBounds | null;
}

export type CommittedObservedRef = Readonly<Omit<ObservedRef, "attrs" | "bounds">> & {
  readonly attrs: Readonly<Record<string, string>>;
  readonly bounds: Readonly<RectBounds> | null;
};

export type CommittedGroundingRecord = Readonly<
  Omit<GroundingRecord, "domPath" | "frameLineage" | "cssSegments" | "xpathSegments" | "attrs" | "bounds">
> & {
  readonly domPath: readonly PathStep[];
  readonly frameLineage: readonly FrameLineageStep[];
  readonly cssSegments: readonly string[];
  readonly xpathSegments: readonly string[];
  readonly attrs: Readonly<Record<string, string>>;
  readonly bounds: Readonly<RectBounds> | null;
};

export interface RenderedPageContent {
  dom: string;
  refs: ObservedRef[];
  groundings: GroundingRecord[];
}

export interface ViewportCapture {
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}