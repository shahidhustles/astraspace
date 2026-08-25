import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { extractPageContent } from "../src/browser/observation/extract";
import { renderPageContent } from "../src/browser/observation/render";
import type { ObservedRef, RectBounds } from "../src/browser/observation/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

const FIXTURE = `<!doctype html>
<html>
  <head><title>Fixture page</title></head>
  <body>
    <h1 id="heading">Fixture page</h1>
    <p id="intro">A visible paragraph with text.</p>
    <div id="fixed-note" style="position: fixed">Fixed note</div>
    <div id="hidden" style="display: none">Hidden text <button id="hidden-button">Hidden button</button></div>
    <div id="offscreen" style="position: absolute; top: -2000px">Offscreen text</div>
    <form id="form">
      <label id="name-label" for="name">Name</label>
      <input id="name" type="text" name="name" value="Alice" />
      <label id="pass-label" for="pass">Password</label>
      <input id="pass" type="password" name="pass" value="s3cret!" />
      <input id="agree" type="checkbox" name="agree" checked />
      <label id="agree-label" for="agree">Agree</label>
      <label id="city-label" for="city">City</label>
      <select id="city" name="city">
        <option id="opt-berlin">Berlin</option>
        <option id="opt-paris" selected>Paris</option>
      </select>
      <button id="submit" type="submit">Submit</button>
      <button id="disabled-button" type="button" disabled>Disabled action</button>
    </form>
    <a id="link" href="https://example.com">Read more</a>
    <div id="role-button" role="button" tabindex="0">Role button</div>
    <div id="tab-target" tabindex="0">Tab target</div>
    <div id="wrapper"><button id="wrapped-button">Wrapped action</button></div>
    <a id="nested" href="https://nested.test"><button id="nested-button">Nested button</button></a>
    <button id="dup-label-button" aria-label="Duplicate label">Duplicate label</button>
    <input id="img-button" type="image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Search" />
    <div id="aria-check" role="checkbox" aria-checked="true" aria-label="Subscribe">Subscribe</div>
    <button id="aria-labelledby" aria-labelledby="labelledby-target">Fallback text</button>
    <span id="labelledby-target" hidden>Send report</span>
  </body>
</html>`;

const LAYOUT: Record<string, RectBounds> = {
  heading: { x: 8, y: 8, width: 120, height: 32 },
  intro: { x: 8, y: 48, width: 400, height: 20 },
  "fixed-note": { x: 700, y: -100, width: 90, height: 24 },
  offscreen: { x: 8, y: -2000, width: 200, height: 50 },
  form: { x: 8, y: 90, width: 700, height: 240 },
  "name-label": { x: 8, y: 96, width: 40, height: 16 },
  name: { x: 60, y: 96, width: 160, height: 24 },
  "pass-label": { x: 8, y: 132, width: 70, height: 16 },
  pass: { x: 90, y: 132, width: 160, height: 24 },
  agree: { x: 8, y: 168, width: 16, height: 16 },
  "agree-label": { x: 30, y: 168, width: 50, height: 16 },
  "city-label": { x: 150, y: 200, width: 30, height: 16 },
  city: { x: 8, y: 200, width: 120, height: 24 },
  submit: { x: 8, y: 276, width: 90, height: 28 },
  "disabled-button": { x: 110, y: 306, width: 130, height: 28 },
  link: { x: 8, y: 320, width: 90, height: 16 },
  "role-button": { x: 8, y: 348, width: 90, height: 20 },
  "tab-target": { x: 110, y: 348, width: 80, height: 20 },
  wrapper: { x: 8, y: 380, width: 200, height: 28 },
  "wrapped-button": { x: 8, y: 384, width: 120, height: 20 },
  nested: { x: 8, y: 420, width: 150, height: 28 },
  "nested-button": { x: 8, y: 424, width: 120, height: 20 },
  "dup-label-button": { x: 8, y: 460, width: 120, height: 20 },
  "img-button": { x: 8, y: 496, width: 100, height: 28 },
  "aria-check": { x: 8, y: 536, width: 120, height: 20 },
  "aria-labelledby": { x: 8, y: 568, width: 120, height: 20 },
};

const EXPECTED_DOM = `<document>
  <h1>Fixture page
  A visible paragraph with text.
  Fixed note
  <form>
    <label>Name
    [1]<input role=textbox type=text name=name value=Alice>Name />
    <label>Password
    [2]<input role=textbox type=password name=pass>Password />
    [3]<input role=checkbox type=checkbox name=agree checked>Agree />
    <label>Agree
    <label>City
    [4]<select role=combobox name=city value=Paris>City />
      <option>Berlin
      <option selected>Paris
    [5]<button type=submit>Submit />
    <button type=button disabled>Disabled action
  [6]<a role=link href=https://example.com>Read more />
  [7]<div role=button>Role button />
  [8]<div>Tab target />
  [9]<button>Wrapped action />
  [10]<a role=link href=https://nested.test>Nested button />
  [11]<button>Duplicate label />
  [12]<input role=button type=image>Search />
  [13]<div role=checkbox aria-checked>Subscribe />
  [14]<button>Send report />`;

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

function renderFixture(): ReturnType<typeof renderPageContent> {
  return renderPageContent(extractPageContent(fixtureWindow()));
}

function refNumbersInDom(dom: string): number[] {
  return [...dom.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

describe("renderPageContent", () => {
  test("renders a stable compact tree in document order", () => {
    const { dom } = renderFixture();
    expect(dom).toBe(EXPECTED_DOM);
  });

  test("gives every actionable control one matching ref record", () => {
    const { dom, refs } = renderFixture();

    expect(refs).toHaveLength(14);
    expect(refs.map((r) => r.ref)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(new Set(refs.map((r) => r.ref)).size).toBe(refs.length);
    expect(refNumbersInDom(dom)).toEqual(refs.map((r) => r.ref));

    expect(refs.map((r) => `${r.tag}:${r.role ?? ""}`)).toEqual([
      "input:textbox",
      "input:textbox",
      "input:checkbox",
      "select:combobox",
      "button:button",
      "a:link",
      "div:button",
      "div:",
      "button:button",
      "a:link",
      "button:button",
      "input:button",
      "div:checkbox",
      "button:button",
    ]);

    const byRef = new Map(refs.map((r) => [r.ref, r]));
    expect(byRef.get(1)?.attrs).toMatchObject({ type: "text", name: "name", value: "Alice" });
    expect(byRef.get(1)?.name).toBe("Name");
    expect(byRef.get(1)?.bounds).toEqual(LAYOUT.name);
    expect(byRef.get(2)?.attrs.value).toBeUndefined();
    expect(byRef.get(2)?.name).toBe("Password");
    expect(byRef.get(3)?.attrs).toMatchObject({ type: "checkbox", checked: "true" });
    expect(byRef.get(3)?.name).toBe("Agree");
    expect(byRef.get(4)?.attrs).toMatchObject({ name: "city", value: "Paris" });
    expect(byRef.get(4)?.name).toBe("City");
    expect(byRef.get(6)?.attrs.href).toBe("https://example.com");
    expect(byRef.get(6)?.name).toBe("Read more");
    expect(byRef.get(7)?.role).toBe("button");
    expect(byRef.get(11)?.attrs).toMatchObject({ "aria-label": "Duplicate label" });
    expect(byRef.get(11)?.name).toBe("Duplicate label");
    expect(byRef.get(12)?.name).toBe("Search");
    expect(byRef.get(12)?.role).toBe("button");
    expect(byRef.get(13)?.role).toBe("checkbox");
    expect(byRef.get(13)?.name).toBe("Subscribe");
    expect(byRef.get(14)?.name).toBe("Send report");
  });

  test("gives no refs to hidden, disabled, or nested targets", () => {
    const { dom, refs } = renderFixture();

    expect(dom).not.toContain("Hidden button");
    expect(dom).not.toContain("Offscreen text");

    expect(refs.some((r) => r.tag === "button" && r.bounds?.y === 306)).toBe(false);
    expect(refs.some((r) => r.tag === "option")).toBe(false);
    expect(refs.some((r) => r.tag === "button" && r.attrs.href !== undefined)).toBe(false);

    expect(dom).toContain("<button type=button disabled>Disabled action");
    expect(refNumbersInDom(dom).filter((n) => n === 10)).toHaveLength(1);
    expect(dom).not.toContain("[10]<button");
  });

  test("drops duplicate labels, layout wrappers, arbitrary attributes, and raw HTML", () => {
    const { dom } = renderFixture();

    expect(dom).not.toContain("aria-label=");
    expect(dom).not.toContain("id=");
    expect(dom).not.toContain("class=");
    expect(dom).not.toContain("<style");
    expect(dom).not.toContain("<script");
    expect(dom).not.toContain("<div id=wrapper");
  });

  test("keeps password values and secrets out of the tree and ref records", () => {
    const { dom, refs } = renderFixture();

    expect(dom).not.toContain("s3cret!");
    expect(JSON.stringify(refs)).not.toContain("s3cret!");
    expect(dom).not.toContain("value=s3cret");
  });

  test("ref records survive a JSON round trip", () => {
    const { refs } = renderFixture();
    expect(JSON.parse(JSON.stringify(refs))).toEqual(refs);
    const sample: ObservedRef = refs[0];
    expect(typeof sample.ref).toBe("number");
    expect(typeof sample.tag).toBe("string");
    expect(Array.isArray(Object.entries(sample.attrs))).toBe(true);
  });
});
