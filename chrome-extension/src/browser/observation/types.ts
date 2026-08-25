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
  children: ExtractedNode[];
}

export type ExtractedNode = ExtractedText | ExtractedElement;

export interface ExtractedPageContent {
  root: ExtractedElement;
  controls: ExtractedElement[];
  viewport: ViewportMeasurements;
}

export interface ObservedRef {
  ref: number;
  tag: string;
  role: string | null;
  name: string | null;
  attrs: Record<string, string>;
  bounds: RectBounds | null;
}

export interface RenderedPageContent {
  dom: string;
  refs: ObservedRef[];
}
