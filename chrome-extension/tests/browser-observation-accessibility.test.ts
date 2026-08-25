import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  computeAccessibleName,
  computeRole,
  enrichPageContentWithAccessibility,
  flattenAXTree,
  type SerializableAXNode,
} from "../src/browser/observation/accessibility";
import { extractPageContent } from "../src/browser/observation/extract";
import type { RectBounds } from "../src/browser/observation/types";

function makeWindow(body: string): Window {
  const win = new Window({ url: "https://fixture.test/", innerWidth: 800, innerHeight: 600 });
  win.document.write(`<!doctype html><html><body>${body}</body></html>`);
  win.document.close();
  return win;
}

function element(win: Window, id: string): Element {
  const el = win.document.getElementById(id);
  if (!el) {
    throw new Error(`Element #${id} not found`);
  }
  return el;
}

describe("computeRole", () => {
  const win = makeWindow(`
    <button id="b">B</button>
    <a id="l" href="#">L</a>
    <a id="nl">NL</a>
    <input id="text" type="text">
    <input id="pw" type="password">
    <input id="cb" type="checkbox">
    <input id="radio" type="radio">
    <input id="submit" type="submit">
    <input id="img" type="image" alt="x">
    <input id="range" type="range">
    <input id="search" type="search">
    <input id="num" type="number">
    <select id="sel"></select>
    <option id="opt"></option>
    <textarea id="ta"></textarea>
    <summary id="sum">Sum</summary>
    <div id="plain"></div>
    <div id="dialog" role="dialog"></div>
  `);

  const cases: Array<[string, string | null]> = [
    ["b", "button"],
    ["l", "link"],
    ["nl", null],
    ["text", "textbox"],
    ["pw", "textbox"],
    ["cb", "checkbox"],
    ["radio", "radio"],
    ["submit", "button"],
    ["img", "button"],
    ["range", "slider"],
    ["search", "searchbox"],
    ["num", "spinbutton"],
    ["sel", "combobox"],
    ["opt", "option"],
    ["ta", "textbox"],
    ["sum", "button"],
    ["plain", null],
    ["dialog", "dialog"],
  ];

  test.each(cases)("maps #%s to %s", (id, expected) => {
    expect(computeRole(element(win, id))).toBe(expected);
  });
});

describe("computeAccessibleName", () => {
  const win = makeWindow(`
    <label for="name">Full name</label><input id="name" type="text">
    <label for="wrap">Wrapped <input id="wrap" type="text"></label>
    <input id="aria-label" type="text" aria-label="Search site">
    <input id="aria-lb" type="text" aria-labelledby="t1 t2"><span id="t1">First</span><span id="t2">Second</span>
    <input id="img" type="image" alt="Find">
    <input id="btnval" type="button" value="Go">
    <input id="title" type="text" title="Tooltip">
    <input id="ph" type="text" placeholder="Search me">
    <button id="desc">Click <img alt="here"> now</button>
    <div id="title-div" title="Titled">D</div>
    <div id="plain"></div>
    <input id="pw" type="password" value="s3cret!">
    <button id="aria-lb-hidden" aria-labelledby="hidden-target">Fallback</button><span id="hidden-target" hidden>Send report</span>
  `);

  const cases: Array<[string, string | null]> = [
    ["name", "Full name"],
    ["wrap", "Wrapped"],
    ["aria-label", "Search site"],
    ["aria-lb", "First Second"],
    ["img", "Find"],
    ["btnval", "Go"],
    ["title", "Tooltip"],
    ["ph", null],
    ["desc", "Click here now"],
    ["title-div", "D"],
    ["plain", null],
    ["pw", null],
    ["aria-lb-hidden", "Send report"],
  ];

  test.each(cases)("names #%s as %s", (id, expected) => {
    expect(computeAccessibleName(win, element(win, id))).toBe(expected);
  });

  test("never derives a name from a password value", () => {
    const name = computeAccessibleName(win, element(win, "pw"));
    expect(name ?? "").not.toContain("s3cret!");
  });
});

describe("flattenAXTree", () => {
  test("keeps control-like nodes in document order and drops inert roles", () => {
    const tree: SerializableAXNode = {
      role: "RootWebArea",
      name: "",
      children: [
        { role: "staticText", name: "hello" },
        { role: "button", name: "Save" },
        { role: "generic", children: [{ role: "textbox", name: "Name" }] },
        { role: "paragraph", children: [{ role: "link", name: "Read more" }] },
      ],
    };

    expect(flattenAXTree([tree])).toEqual([
      { role: "button", name: "Save" },
      { role: "textbox", name: "Name" },
      { role: "link", name: "Read more" },
    ]);
  });
});

const LAYOUT: Record<string, RectBounds> = {
  name: { x: 8, y: 8, width: 160, height: 24 },
  widget: { x: 8, y: 48, width: 100, height: 24 },
  unlabeled: { x: 8, y: 88, width: 160, height: 24 },
};

function contentWindow(): Window {
  const win = makeWindow(`
    <label for="name">Full name</label><input id="name" type="text">
    <div id="widget" tabindex="0">Volume</div>
    <input id="unlabeled" type="text">
  `);
  for (const [id, bounds] of Object.entries(LAYOUT)) {
    const el = win.document.getElementById(id);
    if (!el) {
      throw new Error(`Fixture element #${id} not found`);
    }
    Object.defineProperty(el, "getBoundingClientRect", { value: () => bounds });
  }
  return win;
}

describe("enrichPageContentWithAccessibility", () => {
  test("applies Chromium role and name to the exact resolved control", async () => {
    const content = extractPageContent(contentWindow());
    const widget = content.controls.find((c) => c.bounds?.y === LAYOUT.widget.y);
    expect(widget?.role).toBeNull();
    expect(widget?.name).toBe("Volume");

    await enrichPageContentWithAccessibility(content, async (control) => {
      if (control.name === "Volume") {
        return { role: "slider", name: "Volume" };
      }
      if (control.name === "Full name") {
        return { role: "textbox", name: "Full name" };
      }
      return { role: "textbox" };
    });

    expect(widget?.role).toBe("slider");
    expect(widget?.name).toBe("Volume");

    const unlabeled = content.controls.find((c) => c.bounds?.y === LAYOUT.unlabeled.y);
    expect(unlabeled?.role).toBe("textbox");
    expect(unlabeled?.name).toBeNull();
  });

  test("keeps one control unchanged when Chromium omits only that node", async () => {
    const content = extractPageContent(contentWindow());
    await enrichPageContentWithAccessibility(content, async (control) => {
      if (control.name === "Volume") {
        return null;
      }
      return { role: "textbox", name: control.name ?? undefined };
    });

    const widget = content.controls.find((c) => c.bounds?.y === LAYOUT.widget.y);
    expect(widget?.role).toBeNull();
    expect(widget?.name).toBe("Volume");
  });

  test("ignores missing snapshots and returns the content untouched", async () => {
    const content = extractPageContent(contentWindow());
    const before = JSON.stringify(content);
    const result = await enrichPageContentWithAccessibility(content, async () => null);
    expect(JSON.stringify(result)).toBe(before);
  });

  test("survives a JSON round trip of serialized AX input", async () => {
    const axRoot: SerializableAXNode = {
      role: "RootWebArea",
      children: [
        { role: "textbox", name: "Full name", backendNodeId: 40 },
        { role: "slider", name: "Volume", backendNodeId: 42, value: 50 },
        { role: "textbox", backendNodeId: 44 },
      ],
    };
    const roundTripped = JSON.parse(JSON.stringify(axRoot.children?.[1])) as SerializableAXNode;
    const content = extractPageContent(contentWindow());
    await enrichPageContentWithAccessibility(content, async (control) =>
      control.name === "Volume" ? roundTripped : null,
    );

    const widget = content.controls.find((c) => c.bounds?.y === LAYOUT.widget.y);
    expect(widget?.role).toBe("slider");
    expect(widget?.name).toBe("Volume");
  });

  test("does not shift later controls when one accessibility node is absent", async () => {
    const content = extractPageContent(contentWindow());
    await enrichPageContentWithAccessibility(content, async (control) => {
      if (control.name === "Volume") {
        return null;
      }
      if (control.name === null) {
        return { role: "searchbox", name: "Search" };
      }
      return { role: "textbox", name: control.name };
    });

    const widget = content.controls.find((control) => control.bounds?.y === LAYOUT.widget.y);
    const unlabeled = content.controls.find((control) => control.bounds?.y === LAYOUT.unlabeled.y);
    expect(widget?.role).toBeNull();
    expect(widget?.name).toBe("Volume");
    expect(unlabeled?.role).toBe("searchbox");
    expect(unlabeled?.name).toBe("Search");
  });
});
