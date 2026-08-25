# Astra Space design system

<!-- impeccable:design-schema 1 -->

## Direction

**Private observatory.** Astra Space looks like an instrument for examining outbound context before it crosses a boundary. The near-black violet field and quiet rim light come from `DESIGN.reference.md`. The product-specific layer comes from inspection overlays, telemetry marks, redaction apertures, and a strict before-and-after view of page context.

This is an Operate interface. It must feel precise under pressure, not cinematic for its own sake. Decorative stars, large gradients, and ambient motion never compete with the current task, privacy state, or outbound evidence.

## Design principles

1. **Evidence gets the brightest contrast.** The sanitized payload, protected-count summary, and approval controls outrank decorative branding.
2. **Private and outbound stay spatially distinct.** Raw local context sits to the left or behind the privacy boundary. Sanitized context sits to the right or after it.
3. **Redaction remains legible.** A user can tell whether Astra blocked, masked, or semantically replaced a value without revealing the original.
4. **One primary action per state.** Start, approve, pause, retry, and stop do not compete on the same visual level.
5. **Quiet until intervention matters.** Normal processing uses restrained violet and neutral telemetry. Warning and blocked states appear only when the user must act.

## Visual world

The base scene is a dark observatory console used beside a live webpage. Panels resemble smoked instrument glass catching a narrow internal rim light. Fine orbital tracks and coordinate ticks may organize telemetry, but they are sparse and functional. The privacy boundary is a thin luminous gate between local and outbound context.

The system avoids generic cyber-security tropes. Do not use shield-filled hero art, neon green code rain, padlock wallpaper, floating glass cards, or a permanent starfield behind every screen.

## Color tokens

The strategy is restrained: violet-black neutrals, one lavender brand accent, and semantic colors reserved for decisions and failures.

| Token | Value | Use |
|---|---:|---|
| `--color-space-950` | `#05030d` | App canvas and deepest layer |
| `--color-space-900` | `#090617` | Primary panel surface |
| `--color-space-850` | `#0e0a21` | Raised controls and selected rows |
| `--color-space-800` | `#15102d` | Strong hover and active surface |
| `--color-ink-50` | `#f5f2ff` | Primary text and icons |
| `--color-ink-200` | `#d5cfea` | Strong secondary text |
| `--color-ink-400` | `#9992ad` | Metadata and helper text |
| `--color-ink-600` | `#625c72` | Disabled text and quiet dividers |
| `--color-orbit-400` | `#a89bff` | Active state, focus ring, links, protected values |
| `--color-orbit-500` | `#8878f2` | Primary button and selected control |
| `--color-orbit-700` | `#5145b8` | Pressed primary control |
| `--color-scan-400` | `#72d8e8` | Current scan and live-processing trace |
| `--color-caution-400` | `#f1bd72` | Review needed, low confidence |
| `--color-block-400` | `#f1849d` | Blocked outbound request or destructive failure |
| `--color-success-400` | `#83d7b0` | Completed action and verified local protection |
| `--color-focus-ring` | `#c0b6ff` | Keyboard focus, paired with a 2px offset |

Semantic colors never appear as the only signal. Pair each one with an icon, label, and state-specific copy.

### Gradients

Use a lavender-to-cyan spectral line only for the privacy boundary and short scan traces:

```css
--gradient-boundary: linear-gradient(90deg, #a89bff 0%, #72d8e8 100%);
--gradient-boundary-fade: linear-gradient(
  180deg,
  transparent 0%,
  rgba(168, 155, 255, 0.72) 35%,
  rgba(114, 216, 232, 0.72) 65%,
  transparent 100%
);
```

Never use these gradients as a card fill, page background, or primary button.

## Typography

### Families

- **Display and major section headings:** `Satoshi`, `Avenir Next`, or `Inter` as the final fallback. Use weight 500. The available font must be bundled or loaded explicitly before implementation.
- **Body and controls:** `Inter`, `ui-sans-serif`, `system-ui`. Use weight 400 for prose and 500 for controls.
- **Telemetry and payload data:** `Berkeley Mono`, `IBM Plex Mono`, or `ui-monospace`. Use only for coordinates, durations, counts, JSON, and compact technical labels.

Do not set normal body copy in monospace. Do not use weights above 600. Privacy evidence should feel measured, not militarized.

### Type scale

| Role | Size | Line height | Weight | Use |
|---|---:|---:|---:|---|
| Display | 40px | 1.08 | 500 | Full inspector empty state only |
| Page heading | 28px | 1.18 | 500 | Inspector or settings title |
| Section heading | 20px | 1.25 | 500 | Major panel headings |
| Panel heading | 16px | 1.35 | 500 | Card and region titles |
| Body | 15px | 1.5 | 400 | Primary interface copy |
| Body small | 13px | 1.45 | 400 | Metadata and helper text |
| Label | 12px | 1.3 | 500 | Controls and compact state labels |
| Telemetry | 11px | 1.35 | 500 | Coordinates, timings, and payload keys |

Use sentence case. Avoid uppercase except for short machine tokens such as `EMAIL_1` or `DOM`.

## Spacing and shape

The base unit is 4px.

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
```

Use 8 to 12px gaps inside compact controls, 16px between related groups, and 24 to 32px between major regions.

| Element | Radius |
|---|---:|
| Buttons, fields, segmented controls | 6px |
| Status chips | 999px |
| Compact rows and payload blocks | 10px |
| Panels and dialogs | 16px |
| Large inspector frames | 20px |

Radii describe hierarchy. Do not sprinkle arbitrary 8px, 12px, and 24px values through the interface.

## Surfaces and elevation

Use surface color, a 1px translucent edge, and inset rim light. Avoid external drop shadows inside the extension.

```css
--border-quiet: rgba(213, 207, 234, 0.10);
--border-active: rgba(168, 155, 255, 0.42);
--rim-panel: inset 0 1px 0 rgba(255, 255, 255, 0.055);
--rim-active: inset 0 0 24px rgba(168, 155, 255, 0.07);
--shadow-dialog: 0 24px 80px rgba(2, 1, 8, 0.62);
```

- Canvas uses `--color-space-950`.
- Primary panels use `--color-space-900` with `--border-quiet` and `--rim-panel`.
- Interactive rows use `--color-space-850` on hover or selection.
- Dialogs may use the one external shadow token because they must separate from the inspected page.

## Layout

### Extension popup

The popup is a compact launcher, not the full product. Target a 380px width and a useful height between 520 and 600px.

1. Header with Astra mark, current page trust state, and settings.
2. Task input with one primary action.
3. Current-cycle summary showing Observe, Sanitize, Reason, and Act.
4. Protected-items summary and a clear "Open privacy inspector" action.
5. Stop or pause control anchored at the bottom while the agent runs.

### Privacy inspector

Use a browser side panel or dedicated extension page for the full inspection view.

- The top bar contains task state, page identity, local-processing status, and stop.
- The main comparison uses two panes: **Local view** and **Sent to model**.
- A narrow boundary rail between them shows detection count, sanitization method, and outbound decision.
- The lower region contains action history and timing, collapsed by default when it would reduce comparison height.
- Selecting a detection synchronizes the source bounding box, sanitized replacement, category, confidence, and payload entry.

At narrow widths, stack Local view above Sent to model. Keep the boundary summary between them so the transformation remains obvious.

### Settings

Settings use a single reading column with grouped sections. Model selection, local detector status, redaction policy, accessibility preferences, and integration permissions must not look equally important. Privacy policy and outbound permissions appear first.

## Core components

### Primary button

- Background: `--color-orbit-500`
- Text: `--color-ink-50`
- Radius: 6px
- Height: 40px in the popup, 36px in dense inspector toolbars
- Padding: 0 16px
- Weight: 500
- Hover: `--color-orbit-400`
- Pressed: `--color-orbit-700`
- Focus: 2px `--color-focus-ring`, 2px offset
- Disabled: lower opacity to 0.42 and retain readable text

Only one primary button may appear in a panel or dialog.

### Secondary and quiet buttons

Secondary buttons use `--color-space-850`, `--border-quiet`, and `--color-ink-200`. Quiet buttons use no fill until hover. Destructive stop actions stay quiet during normal operation and gain the block color only in their confirmation state.

### Task composer

The task composer is a multiline field with an integrated submit control, a clear keyboard hint, and a local-processing note. It expands to a practical maximum rather than growing without limit. Empty, composing, running, blocked, and retry states use stable geometry.

### Cycle stepper

Show Observe, Sanitize, Reason, and Act in a compact linear sequence. Completed steps use a check icon and text. The current step uses the scan color and a short moving trace unless reduced motion is active. Future steps remain readable at low contrast.

### Privacy boundary rail

The boundary rail is the signature component. It is a narrow vertical instrument with a spectral line, directional ticks, and a concise verdict:

- `7 detected`
- `7 transformed`
- `0 originals sent`

Counts must come from real runtime data. When unavailable, show `Not measured`, never zero.

### Detection row

Each row includes category, sanitization method, confidence, source type, and locate action. Categories use text labels such as Email or Password. Confidence appears as a number and an optional meter. Do not communicate confidence with color alone.

### Redaction overlay

Bounding boxes use a 1.5px outline, a compact category tab, and a subtle hatched fill. Blocked values use dense hatching. Masked values use medium hatching. Semantic replacements use a light dotted field. Never blur sensitive text because blur can remain readable.

### Context comparison

The comparison component keeps raw and sanitized panes aligned where possible. A draggable divider is optional, but explicit pane labels are mandatory. Keyboard users can move between matched detections and replacements without operating a drag handle.

### Payload viewer

Use monospace text, syntax color with sufficient contrast, line wrapping by default, and a copy control. Private originals must never be present in the DOM of the sanitized pane, including hidden or collapsed content.

### Status chip

Chips are compact and factual: `Local`, `Sanitized`, `Review needed`, `Blocked`, `Sent`, and `Complete`. Pair each state with an icon. Avoid vague labels such as `Secure` or `Safe`.

### Dialog

Dialogs use a 16px radius, 24px padding, one clear title, concise consequences, and one primary decision. Confirmation is required before sending low-confidence sensitive context or stopping a destructive in-progress action.

## Icons and imagery

Use 1.5px stroke icons with rounded joins and no filled tile behind every icon. Prefer concrete browser and inspection symbols: cursor, region box, text scan, eye-off, local device, outbound arrow, pause, and history.

The main product image is the interface operating on a real or clearly labeled demo page. Do not use stock photography, 3D astronauts, planets, or generic AI orbs. A sparse coordinate grid or orbital arc may appear in empty states, capped at low contrast and hidden when it reduces legibility.

## Motion

Motion explains state changes.

- A scan trace moves across the active pane while local perception runs.
- A redaction overlay settles into place after detection.
- The privacy boundary pulses once when an outbound request passes inspection.
- New action-history rows enter without shifting the user's current reading position.

Use 140 to 220ms transitions for controls and 280 to 420ms for page-state changes. Respect `prefers-reduced-motion`; replace traces and pulses with immediate state changes.

Do not animate ambient stars, panel glows, or every hover state.

## Content and state language

Use direct, testable copy.

| Avoid | Use |
|---|---|
| Your data is safe | 7 private values removed |
| Fully secure | No original values sent |
| AI is thinking | Reasoning from sanitized context |
| Something went wrong | Local face detection did not finish |
| Continue | Send sanitized context |
| Allow | Approve this outbound request |

Required states include first run, no active tab, unsupported page, scanning, sanitizing, ready to send, low confidence, blocked outbound request, model unavailable, action failed, task paused, task complete, and local model unavailable.

No state may fabricate a count, confidence value, latency, or successful protection result.

## Accessibility

- Maintain at least WCAG AA text contrast as the implementation target while the product's formal conformance level remains undecided.
- Keep a visible 2px focus ring with 2px separation from the control edge.
- Provide a logical keyboard order across task, inspection, approval, and stop controls.
- Give every icon-only button an accessible name and at least a 36 by 36px hit area.
- Announce cycle changes and blocked requests through appropriately scoped live regions. Do not announce continuous telemetry updates.
- Provide text equivalents for bounding boxes and visual detection overlays.
- Preserve usable layouts at 200% browser zoom.
- Never rely on hue, motion, or spatial position alone to explain privacy state.

## Responsive behavior

- Under 480px, use a single column and move secondary telemetry behind disclosure controls.
- From 480px to 899px, keep one main content column with compact summary rails.
- At 900px and above, use the two-pane comparison with a fixed boundary rail.
- Long URLs, payload keys, translated labels, and 200% text zoom must wrap without covering controls.
- Keep primary actions reachable without requiring precise pointer movement.

## Design rules

### Do

- Make local processing and outbound context visibly different.
- Use inset rim light instead of decorative drop shadows.
- Keep lavender as the brand and focus color.
- Reserve semantic colors for decisions, warnings, and outcomes.
- Show the exact transformation that supports each privacy claim.
- Keep controls compact but never below the accessible hit-area floor.

### Do not

- Copy Reflect Notes branding, component copy, star patterns, or marketing composition.
- Put private originals into hidden DOM, logs, analytics, or sanitized payload previews.
- Use blur as a redaction method.
- Fill the interface with badges, glowing borders, or gradient cards.
- Use color alone for protected, warning, blocked, or complete states.
- Show fabricated zero counts or perfect confidence while data is unavailable.
- Turn the inspector into a dense developer console. Plain-language evidence comes first; raw telemetry is available on demand.

## Implementation seed

```css
:root {
  color-scheme: dark;
  --color-space-950: #05030d;
  --color-space-900: #090617;
  --color-space-850: #0e0a21;
  --color-space-800: #15102d;
  --color-ink-50: #f5f2ff;
  --color-ink-200: #d5cfea;
  --color-ink-400: #9992ad;
  --color-ink-600: #625c72;
  --color-orbit-400: #a89bff;
  --color-orbit-500: #8878f2;
  --color-orbit-700: #5145b8;
  --color-scan-400: #72d8e8;
  --color-caution-400: #f1bd72;
  --color-block-400: #f1849d;
  --color-success-400: #83d7b0;
  --color-focus-ring: #c0b6ff;
  --border-quiet: rgba(213, 207, 234, 0.1);
  --border-active: rgba(168, 155, 255, 0.42);
  --rim-panel: inset 0 1px 0 rgba(255, 255, 255, 0.055);
  --rim-active: inset 0 0 24px rgba(168, 155, 255, 0.07);
  --radius-control: 6px;
  --radius-row: 10px;
  --radius-panel: 16px;
  --radius-frame: 20px;
}
```

## Source boundary

`DESIGN.reference.md` supplied the starting grammar: near-black violet surfaces, soft lavender text, medium-weight headings, a 4px spacing base, compact controls, restrained gradients, and inset rim lighting. This document adapts that grammar to Astra Space's actual product states and accessibility needs. Where the two conflict, privacy comprehension and operation take priority.

This file describes the intended system for the greenfield extension. Implementation remains the source of truth once the interface is built. Update this document when shipped components or tokens change for a durable reason.
