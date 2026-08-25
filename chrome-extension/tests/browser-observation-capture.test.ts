import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  captureHighlightedViewport,
  clipToViewport,
  readJpegDimensions,
} from "../src/browser/observation/capture";
import { extractPageContent } from "../src/browser/observation/extract";
import { renderPageContent } from "../src/browser/observation/render";
import type {
  ObservedRef,
  RectBounds,
  ViewportCapture,
  ViewportMeasurements,
} from "../src/browser/observation/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgABAAEAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+hKKKK/qw/yTP//Z";

const FIXTURE = `<!doctype html>
<html>
  <head><title>Capture fixture</title></head>
  <body>
    <label id="name-label" for="name">Name</label>
    <input id="name" type="text" name="name" value="Alice" />
    <button id="save" type="submit">Save</button>
    <a id="link" href="https://example.com">Read more</a>
    <div id="widget" role="button" tabindex="0">Widget</div>
  </body>
</html>`;

const LAYOUT: Record<string, RectBounds> = {
  name: { x: 60, y: 8, width: 160, height: 24 },
  save: { x: 8, y: 48, width: 90, height: 28 },
  link: { x: 8, y: 96, width: 90, height: 16 },
  widget: { x: 8, y: 128, width: 80, height: 20 },
};

function fixtureWindow(): Window {
  const win = new Window({
    url: "https://fixture.test/",
    innerWidth: VIEWPORT_WIDTH,
    innerHeight: VIEWPORT_HEIGHT,
  });
  win.document.write(FIXTURE);
  win.document.close();
  for (const [id, bounds] of Object.entries(LAYOUT)) {
    const el = win.document.getElementById(id);
    if (!el) {
      throw new Error(`Fixture element #${id} not found`);
    }
    Object.defineProperty(el, "getBoundingClientRect", { value: () => bounds });
  }
  return win;
}

function observeFixture(win: Window): { refs: ObservedRef[]; viewport: ViewportMeasurements } {
  const content = extractPageContent(win);
  const rendered = renderPageContent(content);
  return { refs: rendered.refs, viewport: content.viewport };
}

function visibleLabelNumbers(doc: Document): number[] {
  return [...doc.querySelectorAll(".astra-obs-badge")].map((el) => Number(el.textContent));
}

function overlayNodes(doc: Document): Element[] {
  return [
    ...doc.querySelectorAll(".astra-obs-overlay, .astra-obs-target, .astra-obs-badge"),
  ];
}

function labelBoxes(doc: Document): Array<{ ref: number; left: number; top: number; width: number; height: number }> {
  return [...doc.querySelectorAll(".astra-obs-target")].map((el) => {
    const target = el as HTMLElement;
    return {
      ref: Number(target.dataset.ref),
      left: Number.parseFloat(target.style.left),
      top: Number.parseFloat(target.style.top),
      width: Number.parseFloat(target.style.width),
      height: Number.parseFloat(target.style.height),
    };
  });
}

describe("captureHighlightedViewport", () => {
  test("returns a viewport JPEG whose visible labels match the ref numbers", async () => {
    const win = fixtureWindow();
    const { refs, viewport } = observeFixture(win);
    const seen: number[] = [];

    const result: ViewportCapture = await captureHighlightedViewport({
      refs,
      viewport,
      captureScreenshot: async () => {
        seen.push(...visibleLabelNumbers(win.document));
        return JPEG_BASE64;
      },
      document: win.document,
    });

    expect(refs.map((r) => r.ref)).toEqual([1, 2, 3, 4]);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.data).toBe(JPEG_BASE64);
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test("removes the overlay and temporary style after a successful capture", async () => {
    const win = fixtureWindow();
    const { refs, viewport } = observeFixture(win);

    await captureHighlightedViewport({
      refs,
      viewport,
      captureScreenshot: async () => JPEG_BASE64,
      document: win.document,
    });

    expect(overlayNodes(win.document)).toHaveLength(0);
    expect(win.document.querySelector("[data-astra-observation] style")).toBeNull();
  });

  test("removes the overlay and temporary style when the screenshot fails", async () => {
    const win = fixtureWindow();
    const { refs, viewport } = observeFixture(win);

    await expect(
      captureHighlightedViewport({
        refs,
        viewport,
        captureScreenshot: async () => {
          throw new Error("screenshot failed");
        },
        document: win.document,
      }),
    ).rejects.toThrow("screenshot failed");

    expect(overlayNodes(win.document)).toHaveLength(0);
    expect(win.document.querySelector("[data-astra-observation] style")).toBeNull();
  });

  test("clips label boxes to the viewport and leaves ref bounds unchanged", async () => {
    const win = fixtureWindow();
    const { viewport } = observeFixture(win);
    const refs: ObservedRef[] = [
      { ref: 1, tag: "button", role: "button", name: "A", attrs: {}, bounds: { x: 20, y: -10, width: 100, height: 20 } },
      { ref: 2, tag: "button", role: "button", name: "B", attrs: {}, bounds: { x: 780, y: 20, width: 60, height: 20 } },
      { ref: 3, tag: "button", role: "button", name: "C", attrs: {}, bounds: { x: -100, y: -100, width: 20, height: 20 } },
    ];
    const before = JSON.stringify(refs);

    await captureHighlightedViewport({
      refs,
      viewport,
      captureScreenshot: async () => JPEG_BASE64,
      document: win.document,
    });

    expect(JSON.stringify(refs)).toBe(before);
  });

  test("draws partially visible refs clipped to the viewport and skips fully offscreen refs", async () => {
    const win = fixtureWindow();
    const { viewport } = observeFixture(win);
    const refs: ObservedRef[] = [
      { ref: 1, tag: "button", role: "button", name: "A", attrs: {}, bounds: { x: 20, y: -10, width: 100, height: 20 } },
      { ref: 2, tag: "button", role: "button", name: "B", attrs: {}, bounds: { x: 780, y: 20, width: 60, height: 20 } },
      { ref: 3, tag: "button", role: "button", name: "C", attrs: {}, bounds: { x: -100, y: -100, width: 20, height: 20 } },
    ];
    let boxes: ReturnType<typeof labelBoxes> = [];

    await captureHighlightedViewport({
      refs,
      viewport,
      captureScreenshot: async () => {
        boxes = labelBoxes(win.document);
        return JPEG_BASE64;
      },
      document: win.document,
    });

    expect(boxes).toEqual([
      { ref: 1, left: 20, top: 0, width: 100, height: 10 },
      { ref: 2, left: 780, top: 20, width: 20, height: 20 },
    ]);
  });

  test("cleanup preserves page-owned nodes with Astra-like identifiers", async () => {
    const win = fixtureWindow();
    const { refs, viewport } = observeFixture(win);
    const pageStyle = win.document.createElement("style");
    pageStyle.id = "astra-obs-style";
    pageStyle.textContent = ".page-owned { color: red }";
    const pageNode = win.document.createElement("div");
    pageNode.className = "astra-obs-overlay astra-obs-target astra-obs-badge";
    pageNode.textContent = "Page owned";
    win.document.body.append(pageStyle, pageNode);

    await captureHighlightedViewport({
      refs,
      viewport,
      captureId: "capture-1",
      captureScreenshot: async () => JPEG_BASE64,
      document: win.document,
    });

    expect(win.document.getElementById("astra-obs-style")).toBe(pageStyle);
    expect(win.document.body.contains(pageNode)).toBe(true);
    expect(win.document.querySelector("[data-astra-observation]")).toBeNull();
  });

  test("cleanup runs when overlay construction fails", async () => {
    const win = fixtureWindow();
    const { refs, viewport } = observeFixture(win);
    const originalAppend = win.document.documentElement.appendChild.bind(win.document.documentElement);
    win.document.documentElement.appendChild = (() => {
      throw new Error("append failed");
    }) as typeof win.document.documentElement.appendChild;

    try {
      await expect(
        captureHighlightedViewport({
          refs,
          viewport,
          captureId: "capture-2",
          captureScreenshot: async () => JPEG_BASE64,
          document: win.document,
        }),
      ).rejects.toThrow("append failed");
    } finally {
      win.document.documentElement.appendChild = originalAppend;
    }

    expect(win.document.querySelector("[data-astra-observation]")).toBeNull();
  });
});

describe("readJpegDimensions", () => {
  test("reads encoded pixel dimensions and rejects invalid image data", () => {
    expect(readJpegDimensions(JPEG_BASE64)).toEqual({ width: 4, height: 4 });
    expect(readJpegDimensions("not a jpeg")).toBeNull();
  });
});

describe("clipToViewport", () => {
  test("intersects bounds with the viewport and returns null when empty", () => {
    expect(clipToViewport({ x: 20, y: -10, width: 100, height: 20 }, 800, 600)).toEqual({
      x: 20,
      y: 0,
      width: 100,
      height: 10,
    });
    expect(clipToViewport({ x: 780, y: 20, width: 60, height: 20 }, 800, 600)).toEqual({
      x: 780,
      y: 20,
      width: 20,
      height: 20,
    });
    expect(clipToViewport({ x: -100, y: -100, width: 20, height: 20 }, 800, 600)).toBeNull();
    expect(clipToViewport({ x: 0, y: 0, width: 800, height: 600 }, 800, 600)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });
});
