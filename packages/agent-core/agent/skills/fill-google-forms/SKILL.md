---
description: Use when the user asks to fill in a Google Form, complete a Google Forms questionnaire, submit responses to a form, or fill out a survey/check-in form. Covers all Google Form types.
---

# Fill Google Forms

Reliable procedure to fill and submit any Google Form (multiple choice /
radio, checkboxes, text, dropdown, and mixed forms). Follow in order; verify
before declaring success.

## Golden rules

1. **The accessibility tree hides the form controls.** Google Forms renders
   radios/checkboxes/submit as `div[role="radio"]` / `div[role="checkbox"]` /
   a styled `DIV` submit button — `read_page` (even `filter: "interactive"`)
   often shows only the text inputs, and `find` misses the controls entirely.
   Use `javascript_tool` to inspect and drive the DOM directly.
2. **The chosen radio/checkbox center must be the small circle, not the label
   text.** The label text sits BELOW/next to the circle; clicking the rect
   center of the whole option often lands on the label and does nothing. Get
   each option's rect, then click the CIRCLE (`input/span` inside), or pick a
   point near the top-left of the option rect, and ALWAYS verify the
   `aria-checked` state afterwards.
3. **Verify success via the page body text**, not the URL or the button click
   itself. Google Forms shows "Your response has been recorded" on the
   confirmation page. The URL changing to include `?fbzx=...` does NOT mean it
   submitted. If the body does not contain that phrase after clicking Submit,
   the form did not go through — re-check required fields.
4. **Answer every required question** (marked `*`). If a required question is
   empty, Google Forms blocks submission with "This is a required question".
5. **Set text inputs via `form_input`** (or JS `input.value` + dispatch
   `input`/`change` events, needed when `form_input` can't reach the field).
6. **The submit control is a `DIV`**, found via JS by text "Submit" — not via
   `find` (which returns "help and feedback" instead). Use the JS snippet below.

## Steps

### 1. Get the agent tab and open the form (only if the page is not already opened)

Call `tabs_context_mcp` (`createIfEmpty: true` if needed). Find the tab whose
title/URL is the Google Form (it looks like
`https://docs.google.com/forms/d/e/<id>/viewform`). If it's not open, navigate
to the form URL.

### 2. Read the page text to learn the questions and types

Use `get_page_text` (NOT `read_page` — the a11y tree hides radios). This shows
each question's label, its required `*` marker, and its options. Identify:
- Text / number inputs (fill with `form_input` or JS)
- Multiple choice → radios (`div[role="radio"]`)
- Checkboxes → checkboxes (`div[role="checkbox"]`)
- Dropdowns → Google Forms dropdowns are `<div role="listbox">`; click the
  dropdown, then click the option `div[role="option"]`

### 3. Inspect the actual controls via JS

```js
(() => {
  const out = [];
  document.querySelectorAll('[role="radio"],[role="checkbox"],[role="option"],[role="listbox"]').forEach(r => {
    out.push({ role: r.getAttribute('role'), ariaLabel: r.getAttribute('aria-label'), checked: r.getAttribute('aria-checked'), text: r.textContent.trim().slice(0,50), parent: r.parentElement ? r.parentElement.className.slice(0,60) : '' });
  });
  const inputs = [...document.querySelectorAll('input[type="text"], input[type="number"], textarea')].map(i => ({ tag: i.tagName, type: i.type, name: i.name || i.id || '', placeholder: i.placeholder || '' }));
  return JSON.stringify({ controls: out, inputs }, null, 2);
})()
```

Lists every control, its aria-label, whether it's checked, and all text/number
inputs.

### 4. Fill text / number inputs

Use `form_input` with the ref from `read_page` (it DOES show textboxes). For
inputs `form_input` cannot reach, use JS:

```js
(() => {
  const setVal = (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const a = setVal('input[type="text"]', 'YOUR_VALUE');
  return JSON.stringify({ set: a });
})()
```

### 5. Select radio / checkbox / dropdown options

For each required-choice question, pick ONE option (radio) or the asked ones
(checkbox), then get its precise center:

```js
(() => {
  const radios = document.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"]');
  const out = [];
  radios.forEach(r => {
    const label = r.getAttribute('aria-label') || r.textContent.trim().slice(0, 30);
    const rect = r.getBoundingClientRect();
    // The clickable circle is inside; use the element's own center but the
    // circle is usually the top-left quadrant. Report both.
    out.push({ label, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }, center: { x: Math.round(rect.x + rect.width/2), y: Math.round(rect.y + rect.height/2) }, topLeft: { x: Math.round(rect.x + rect.width*0.2), y: Math.round(rect.y + rect.height*0.3) } });
  });
  return JSON.stringify(out, null, 1);
})()
```

Then `computer` `left_click` each chosen option. Start with `center`; if the
`aria-checked` does not flip to `true` after the click, retry at `topLeft`
(the circle). For dropdowns: click the `role="listbox"`, wait, then click the
matching `role="option"`.

### 6. Verify all selections landed

```js
(() => {
  const radios = document.querySelectorAll('[role="radio"], [role="checkbox"]');
  const checked = [];
  radios.forEach(r => { if (r.getAttribute('aria-checked') === 'true') checked.push(r.getAttribute('aria-label')); });
  const inputs = [...document.querySelectorAll('input[type="text"], input[type="number"], textarea')];
  const values = inputs.map(i => i.value);
  return JSON.stringify({ checked, values, hasRequired: /This is a required question/.test(document.body.innerText) });
})()
```

Every required question must have a checked option / non-empty value. Fix any
missed one (re-click at `topLeft`).

### 7. Find and click the real Submit button

`find` returns the wrong element ("help and feedback"). Use JS:

```js
(() => {
  const btns = [...document.querySelectorAll('div[role="button"], button, [role="button"]')];
  const res = [];
  btns.forEach(b => {
    const t = (b.textContent || '').trim();
    if (/submit/i.test(t) || /submit/i.test(b.getAttribute('aria-label') || '')) {
      const r = b.getBoundingClientRect();
      res.push({ text: t.slice(0, 30), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: b.tagName, cls: b.className.slice(0,50) });
    }
  });
  return JSON.stringify(res);
})()
```

`computer` `left_click` the first result (e.g. the `DIV` with class
`uArJ5e UQuaGc...` text "Submit").

### 8. Verify submission — the REAL check

Wait 1-3s, then:

```js
(() => {
  const bodyText = document.body ? document.body.innerText : '';
  const hasSuccess = /response has been recorded/i.test(bodyText);
  const hasError = /this is a required question|required/i.test(bodyText);
  const errs = [...document.querySelectorAll('[role="alert"], [class*="error"]')].map(e => (e.innerText || '').trim().slice(0, 80)).filter(Boolean).slice(0, 5);
  return JSON.stringify({ hasSuccess, hasError, errs });
})()
```

- `hasSuccess: true` → done. Report the form title and submitted responses.
- `hasError: true` or `hasSuccess: false` → a required field is missing or
  submit failed. Re-run steps 6-8 (re-select the missing option at `topLeft`,
  fill the missing input). Do NOT declare success until `hasSuccess` is true.

## Notes / gotchas

- Google Forms may show "Draft saved" — that is not a submission.
- The URL gaining `?fbzx=` is NOT success; only the confirmation body text is.
- Radios/checkbox circle coordinates drift: if a click doesn't flip
  `aria-checked`, click the top-left of the option rect (the circle region),
  then re-verify.
- After a successful submit the form is replaced by the confirmation page, so
  the controls disappear — that is expected and confirms success.
- For pages requiring navigation (login etc.), call `navigate` / handle auth
  first, then repeat the flow.