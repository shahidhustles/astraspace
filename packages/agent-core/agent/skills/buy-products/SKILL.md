---
description: Use when the user asks to add a product to a shopping cart (Amazon or other e-commerce sites), buy an item, or check out a product.
---

# Buy Products — add a product to cart

A reliable, step-by-step procedure for adding a product to a shopping cart on
e-commerce sites, starting with Amazon. Follow these steps in order. Do NOT skip
the verification steps — they are what make this reliable instead of a loop.

## Golden rules

1. **Never click the first "Add to cart" match from `find` or `read_page`.** On
   Amazon, the keyboard-shortcut "Add to cart, shift, option, K" element
   (hidden at x ≈ -9788) matches before the real buybox button. Clicking it
   fails with "Could not bring ref into view".
2. **Never use the direct add-to-cart URL** (`/gp/cart/add.html?ASIN.1=...`).
   Amazon rejects it with a 404 page ("kailey-kitty" / Page Not Found) because
   it needs session/CSRF state.
3. **The real button is `#add-to-cart-button`, always below the fold** on the
   product page (the buybox is at the bottom, past "About this item" and
   reviews). You MUST scroll it into view first, then click its center.
4. **Verify before declaring success**: read the cart count
   (`#nav-cart-count`) or the confirmation text. Never assume the click worked.

## Steps

### 1. Get the agent tab

Call `tabs_context_mcp` with `{ createIfEmpty: true }`. Use the agent tab
(group: "agent"). If you don't have the product page open yet, `navigate` the
agent tab to the product URL (`https://www.amazon.in/dp/<ASIN>` or the product
page URL from a search result).

### 2. Confirm the page loaded and the buybox exists

Use `javascript_tool` to check the real button is present:

```js
JSON.stringify({ hasBtn: !!document.querySelector('#add-to-cart-button'), title: document.title.slice(0, 60) })
```

- If `hasBtn: false`: the page may be a 404 ("Page Not Found"), a captcha, or a
  variant page. Re-navigate, or search for the product first (`find` /
  `navigate` to a search URL `https://www.amazon.in/s?k=<query>`), open a
  result, and re-check.

### 3. Scroll the real button into view AND verify the hit target

Use `javascript_tool` to scroll `#add-to-cart-button` to the center of the
viewport and report its exact center coordinates plus what element is actually
at that point:

```js
(() => {
  const b = document.querySelector('#add-to-cart-button');
  if (!b) return 'NO_BUTTON';
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  return JSON.stringify({ x, y, off: r.top < 0 || r.bottom > innerHeight, hitId: hit.id || '', hitTag: hit.tagName });
})()
```

The result MUST show `off: false` and `hitId: "add-to-cart-button"`. If `off:
true`, scroll again (the page may have re-laid-out). If `hitId` is something
else (a div, an overlay like "Added to cart", a warranty upsell), the item may
already be in the cart or an overlay is covering the button — read the page
text to check, then either proceed to verify the cart or close the overlay.

### 4. Click the button center

Call `computer` with `action: "left_click"` and the exact `coordinate: [x, y]`
from step 3. (Do NOT use a ref from `find` — the refs match the hidden shortcut
button first.)

### 5. Verify the item is in the cart

Wait ~1-2s (use `computer` `wait` with `duration: 1`), then read the cart
count:

```js
JSON.stringify({ count: (document.querySelector('#nav-cart-count') || {}).textContent })
```

- `count` incremented (or is `1`+ and the item title matches): success. Stop
  and report.
- Count is `0` / unchanged: re-run steps 3-5. If it fails twice, navigate to
  `https://www.amazon.in/gp/cart/view.html` and read the page to see the actual
  cart state (items may already be there from a previous attempt).

### 6. (Optional) Confirm in the cart page

Navigate to `https://www.amazon.in/gp/cart/view.html` and check the
`.sc-product-title` elements contain the expected product.

## Search-then-add flow (when you only have a query)

1. `navigate` the agent tab to `https://www.amazon.in/s?k=<url-encoded query>`
2. `read_page` (filter `interactive`) or `find` with the product name
3. Product links are `link` elements with `href="/dp/<ASIN>"`. Pick an ORGANIC
   (non-"Sponsored") result — sponsored results are ads and their clicks are
   unreliable. Open it via `navigate` to the `href`.
4. Then run steps 2-5 above.

## Other sites (future)

This skill currently covers Amazon. For other sites: find the add-to-cart
control the same way (prefer a stable selector via `javascript_tool`, scroll it
into view, verify the hit target, click, verify the cart). Never trust the
first `find` match; never click off-viewport elements.
