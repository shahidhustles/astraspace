import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { extractPageContent } from "../src/browser/observation/extract";
import type {
  ExtractedElement,
  ExtractedNode,
  ExtractedPageContent,
  RectBounds,
} from "../src/browser/observation/types";

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
const DOCUMENT_HEIGHT = 1200;

const FIXTURE = `<!doctype html>
<html>
  <head><title>Fixture page</title></head>
  <body>
    <h1 id="heading">Fixture page</h1>
    <p id="intro">A visible paragraph with text.</p>
    <div id="fixed-note" style="position: fixed">Fixed note</div>
    <div id="hidden" style="display: none">Hidden text <button id="hidden-button">Hidden button</button></div>
    <div id="vis-hidden" style="visibility: hidden">Hidden by visibility</div>
    <div id="opacity-zero" style="opacity: 0">Invisible opacity</div>
    <div id="hidden-attr" hidden>Hidden attribute</div>
    <div id="zero-area" style="width: 0; height: 0">Zero area text</div>
    <div id="zero-height" style="height: 0">Zero height</div>
    <div id="offscreen" style="position: absolute; top: -2000px">Offscreen text</div>
    <svg id="icon"><text>SVG label</text></svg>
    <script>const secret = "script secret";</script>
    <style>p { color: red }</style>
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
    <input id="img-button" type="image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Search" />
    <div id="aria-check" role="checkbox" aria-checked="true" aria-label="Subscribe">Subscribe</div>
    <button id="aria-labelledby" aria-labelledby="labelledby-target">Fallback text</button>
    <span id="labelledby-target" hidden>Send report</span>
    <div id="inert-region" inert>Inert content <button id="inert-button">Inert button</button></div>
    <iframe id="frame" src="https://example.com"></iframe>
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
  "img-button": { x: 8, y: 420, width: 100, height: 28 },
  "aria-check": { x: 8, y: 460, width: 120, height: 20 },
  "aria-labelledby": { x: 8, y: 492, width: 120, height: 20 },
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

function setScroll(win: Window, scrollX: number, scrollY: number): void {
  Object.defineProperty(win, "scrollX", { value: scrollX, configurable: true });
  Object.defineProperty(win, "scrollY", { value: scrollY, configurable: true });
  const documentElement = win.document.documentElement;
  Object.defineProperty(documentElement, "scrollWidth", { value: VIEWPORT_WIDTH, configurable: true });
  Object.defineProperty(documentElement, "scrollHeight", { value: DOCUMENT_HEIGHT, configurable: true });
}

function collectText(nodes: ExtractedNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === "text") {
      out.push(node.text);
    } else {
      collectText(node.children, out);
    }
  }
  return out;
}

function controlAtY(content: ExtractedPageContent, y: number): ExtractedElement {
  const control = content.controls.find((c) => c.bounds?.y === y);
  if (!control) {
    throw new Error(`No control at y=${y}`);
  }
  return control;
}

describe("extractPageContent", () => {
  test("keeps visible text in document order and drops hidden content", () => {
    const win = fixtureWindow();
    setScroll(win, 0, 0);

    const content = extractPageContent(win);

    expect(collectText(content.root.children)).toEqual([
      "Fixture page",
      "A visible paragraph with text.",
      "Name",
      "Password",
      "Agree",
      "City",
      "Berlin",
      "Paris",
      "Submit",
      "Disabled action",
      "Read more",
      "Role button",
      "Tab target",
      "Wrapped action",
      "Subscribe",
      "Fallback text",
    ]);

    const allText = collectText(content.root.children).join(" ");
    expect(allText).not.toContain("Hidden text");
    expect(allText).not.toContain("Hidden by visibility");
    expect(allText).not.toContain("Invisible opacity");
    expect(allText).not.toContain("Hidden attribute");
    expect(allText).not.toContain("Zero area text");
    expect(allText).not.toContain("Zero height");
    expect(allText).not.toContain("Offscreen text");
    expect(allText).not.toContain("SVG label");
    expect(allText).not.toContain("script secret");
    expect(allText).not.toContain("color: red");
    expect(allText).not.toContain("Inert content");
  });

  test("retains actionable and contextual controls with viewport bounds", () => {
    const win = fixtureWindow();
    setScroll(win, 0, 0);

    const content = extractPageContent(win);

    expect(content.controls).toHaveLength(15);
    expect(content.controls.map((c) => c.tag)).toEqual([
      "input",
      "input",
      "input",
      "select",
      "option",
      "option",
      "button",
      "button",
      "a",
      "div",
      "div",
      "button",
      "input",
      "div",
      "button",
    ]);
    expect(content.controls.every((c) => c.interactive)).toBe(true);
    expect(content.controls.filter((c) => c.disabled).map((c) => c.tag)).toEqual(["button"]);

    const name = controlAtY(content, 96);
    expect(name.tag).toBe("input");
    expect(name.role).toBe("textbox");
    expect(name.name).toBe("Name");
    expect(name.attrs).toMatchObject({ type: "text", name: "name", value: "Alice" });
    expect(name.bounds).toEqual({ x: 60, y: 96, width: 160, height: 24 });

    const pass = controlAtY(content, 132);
    expect(pass.tag).toBe("input");
    expect(pass.role).toBe("textbox");
    expect(pass.name).toBe("Password");
    expect(pass.attrs).toMatchObject({ type: "password", name: "pass" });
    expect(pass.attrs.value).toBeUndefined();

    const agree = controlAtY(content, 168);
    expect(agree.role).toBe("checkbox");
    expect(agree.name).toBe("Agree");
    expect(agree.attrs.checked).toBe("true");

    const city = controlAtY(content, 200);
    expect(city.tag).toBe("select");
    expect(city.role).toBe("combobox");
    expect(city.name).toBe("City");
    expect(city.attrs.value).toBe("Paris");

    const options = content.controls.filter((c) => c.tag === "option");
    expect(options).toHaveLength(2);
    expect(options[0].role).toBe("option");
    expect(options[0].name).toBe("Berlin");
    expect(options[1].attrs.selected).toBe("true");
    expect(options.every((c) => c.bounds === null)).toBe(true);

    const submit = controlAtY(content, 276);
    expect(submit.tag).toBe("button");
    expect(submit.role).toBe("button");
    expect(submit.name).toBe("Submit");
    expect(submit.bounds).toEqual(LAYOUT.submit);

    const disabledButton = controlAtY(content, 306);
    expect(disabledButton.tag).toBe("button");
    expect(disabledButton.interactive).toBe(true);
    expect(disabledButton.disabled).toBe(true);
    expect(disabledButton.name).toBe("Disabled action");

    const link = controlAtY(content, 320);
    expect(link.tag).toBe("a");
    expect(link.role).toBe("link");
    expect(link.name).toBe("Read more");
    expect(link.attrs.href).toBe("https://example.com");

    expect(content.controls.some((c) => c.bounds?.y === 348 && c.role === "button")).toBe(true);
    expect(content.controls.some((c) => c.bounds?.y === 348 && c.tag === "div" && c.role === null)).toBe(true);
    expect(content.controls.some((c) => c.bounds?.y === 380)).toBe(false);
    expect(content.controls.some((c) => c.bounds?.y === 384)).toBe(true);

    const imageButton = controlAtY(content, 420);
    expect(imageButton.tag).toBe("input");
    expect(imageButton.role).toBe("button");
    expect(imageButton.name).toBe("Search");
    expect(imageButton.attrs.alt).toBe("Search");

    const ariaCheck = controlAtY(content, 460);
    expect(ariaCheck.role).toBe("checkbox");
    expect(ariaCheck.name).toBe("Subscribe");
    expect(ariaCheck.attrs["aria-checked"]).toBe("true");

    const ariaLabelledby = controlAtY(content, 492);
    expect(ariaLabelledby.tag).toBe("button");
    expect(ariaLabelledby.name).toBe("Send report");
  });

  test("reports viewport bounds, document size, scroll ranges, and edge flags", () => {
    const win = fixtureWindow();
    setScroll(win, 0, 0);

    const top = extractPageContent(win);

    expect(top.viewport).toEqual({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      width: 800,
      height: 600,
      documentWidth: 800,
      documentHeight: 1200,
      scroll: {
        x: 0,
        y: 0,
        maxX: 0,
        maxY: 600,
        atTop: true,
        atBottom: false,
        atLeft: true,
        atRight: true,
      },
    });

    setScroll(win, 0, 600);
    const bottom = extractPageContent(win);

    expect(bottom.viewport.scroll).toEqual({
      x: 0,
      y: 600,
      maxX: 0,
      maxY: 600,
      atTop: false,
      atBottom: true,
      atLeft: true,
      atRight: true,
    });
  });

  test("survives a JSON round trip without leaking secrets", () => {
    const win = fixtureWindow();
    setScroll(win, 0, 0);

    const content = extractPageContent(win);

    const json = JSON.stringify(content);
    expect(json).not.toContain("s3cret!");
    expect(JSON.parse(json)).toEqual(content);
  });

  test("redacts values from controls that carry secret signals", () => {
    const win = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    win.document.body.innerHTML = `
      <input id="otp" autocomplete="one-time-code" value="654321">
      <textarea id="token" name="api_token">private-token</textarea>
      <select id="recovery" name="recovery_code"><option selected>backup-secret</option></select>
    `;
    for (const [index, id] of ["otp", "token", "recovery"].entries()) {
      const el = win.document.getElementById(id);
      if (!el) throw new Error(`Element #${id} not found`);
      Object.defineProperty(el, "getBoundingClientRect", {
        value: () => ({ x: 8, y: 8 + index * 40, width: 180, height: 24 }),
      });
    }

    const json = JSON.stringify(extractPageContent(win));

    expect(json).not.toContain("654321");
    expect(json).not.toContain("private-token");
    expect(json).not.toContain("backup-secret");
  });

  test("recognizes property and pointer click behavior without an inline attribute", () => {
    const win = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    win.document.body.innerHTML = `
      <div id="property-click">Property click</div>
      <div id="pointer-click" style="cursor: pointer">Pointer click</div>
    `;
    const propertyClick = win.document.getElementById("property-click");
    const pointerClick = win.document.getElementById("pointer-click");
    if (!(propertyClick instanceof win.HTMLElement) || !pointerClick) {
      throw new Error("click fixtures missing");
    }
    propertyClick.onclick = () => {};
    for (const [index, el] of [propertyClick, pointerClick].entries()) {
      Object.defineProperty(el, "getBoundingClientRect", {
        value: () => ({ x: 8, y: 8 + index * 40, width: 180, height: 24 }),
      });
    }

    const content = extractPageContent(win);

    expect(content.controls.map((control) => control.name)).toEqual(["Property click", "Pointer click"]);
    expect(content.controls.map((control) => control.ref)).toEqual([1, 2]);
  });

  test("does not treat contenteditable false as actionable", () => {
    const win = new Window({
      url: "https://fixture.test/",
      innerWidth: VIEWPORT_WIDTH,
      innerHeight: VIEWPORT_HEIGHT,
    });
    win.document.body.innerHTML = `
      <div id="editable" contenteditable="true">Editable</div>
      <div id="not-editable" contenteditable="false">Not editable</div>
    `;
    for (const [index, id] of ["editable", "not-editable"].entries()) {
      const el = win.document.getElementById(id);
      if (!el) throw new Error(`Element #${id} not found`);
      Object.defineProperty(el, "getBoundingClientRect", {
        value: () => ({ x: 8, y: 8 + index * 40, width: 180, height: 24 }),
      });
    }

    const content = extractPageContent(win);

    expect(content.controls.map((control) => control.name)).toEqual(["Editable"]);
  });

  test("skips iframe and shadow-root content", () => {
    const win = fixtureWindow();
    const host = win.document.createElement("div");
    host.id = "shadow-host";
    host.textContent = "Shadow wrapper text";
    host.attachShadow({ mode: "open" });
    host.shadowRoot!.innerHTML = "<button>Shadow button</button>";
    win.document.body.appendChild(host);
    setScroll(win, 0, 0);

    const content = extractPageContent(win);

    const json = JSON.stringify(content);
    expect(json).not.toContain("Shadow wrapper text");
    expect(json).not.toContain("Shadow button");
    expect(json).not.toContain('"iframe"');
  });
});
