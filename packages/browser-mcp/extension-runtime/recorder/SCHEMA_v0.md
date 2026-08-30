# Recording bundle — schema v0

This file ships inside every recording bundle. It describes the structure of
the contents so a reading agent needs no external prompt. It is versioned and
meant to be near-permanent; the notification references it as `schema: "v0"`.

## What a bundle is

An expert's browser rollout, captured as **four parallel tracks on one clock**,
plus the audio the narration was transcribed from and the frames referenced by
the image track.

```
<recording_id>/
  trace.json     — the four tracks (this schema)
  audio/         — the raw narration, in segments (000.webm, 001.webm, ...)
  images/        — 240p frames referenced by the image track (00001.jpg, ...)
  SCHEMA_v0.md   — this file
```

The audio is written in ~10-minute segments, each a complete, independently
decodable WebM. They are recorded back-to-back from one continuous microphone
stream, so together they are the whole session; each is anchored to the shared
clock by `transcript_segments[].t` below. They are written to disk **before**
transcription is attempted, so a failed transcript is always recoverable.

Nothing is forced on you: the tracks and the images are just data on a shared
clock. Read whichever tracks, and open whichever frames, you actually need.

## trace.json

```
{
  "schema": "v0",
  "recording_id": "rec_...",
  "started_at": <epoch ms>,      // the shared zero for ALL tracks
  "ended_at":   <epoch ms>,
  "url0": "<first URL>",
  "behavior":  [ ... ],          // Track A — discrete actions
  "cursor":    [ ... ],          // Track C — raw cursor trajectory
  "images":    [ ... ],          // Track D — frame references
  "cognitive": [ ... ],          // Track B — narration

  // Whether Track B can be trusted. READ THIS BEFORE READING cognitive[].
  "transcript_status": "ok" | "failed: <reason>" | "partial: <reason>",
  "transcript_segments": [       // one per audio segment, on the shared clock
    { "index": 0, "t": <ms>, "status": "ok" | "failed: <reason>" }
  ]
}
```

**An empty `cognitive[]` is not evidence of a silent operator.** It means one
of two very different things, and `transcript_status` is the only way to tell
them apart:

- `"ok"` → the operator genuinely did not speak in that window.
- anything else → narration was captured but not transcribed. The audio is in
  `audio/`; `transcript_segments` says which spans are missing and why.

The same applies to a *gap* in `cognitive[]`: check whether the segment
covering that span has `status: "ok"` before concluding it was quiet.

**The three tracks are independent and overlap.** They are NOT interleaved into
one list — the operator talks *while* acting and *while* moving the cursor.
Align them yourself on the shared clock: every `t` (and `end`) is
**milliseconds since `started_at`**.

### Track A — `behavior[]` (discrete actions, what the operator did)

```
{
  "t": <ms>,
  "tab": <chrome tabId>,         // events are namespaced by (tab, frame):
  "frame": <frameId>,            // each document numbers its own nodes
  "action": "left_click" | "right_click" | "double_click" | "triple_click" |
            "hover" | "left_click_drag" | "type" | "key" | "scroll" |
            "navigate" | "tab_activated" | "tab_opened" | "tab_closed",

  // --- THE CORE KEY: the exact OCIC tool call that reproduces this event ---
  "command": {
    "tool": "computer" | "navigate" | "tabs_create_mcp" | "tabs_close_mcp",
    "input": {                   // the tool's input, 1:1 field names and units.
      "action": "left_click",    //   computer only
      "coordinate": [<x>, <y>],  //   viewport px — the exact space OCIC
                                 //   dispatches in (CDP) and the cursor track uses
      "start_coordinate": [..],  //   left_click_drag only
      "modifiers": "ctrl+cmd",   //   clicks, when held (OCIC syntax)
      "text": "...",             //   type: committed field text; key: "cmd+a"/"Enter"
      "scroll_direction": "...", //   scroll: up|down|left|right
      "scroll_amount": <1..10>,  //   wheel ticks; 1 tick = 100px (OCIC's constant)
      "url": "..."               //   navigate only
    }                            // add the event's `tab` as tabId to replay.
  },                             // ABSENT only on tab_activated (no OCIC verb).

  // --- recorder enrichments (everything below has no OCIC equivalent) ---
  "url": "...",                  // tab context on navigate / tab_* events
  "t_down": <ms>, "t_up": <ms>,  // drag only: the curve for this range is in the
                                 // cursor track
  "vw": <px>, "vh": <px>,        // viewport at capture; (x/vw, y/vh) places the
                                 // event on the nearest frame, like cursor points
  "anchor": { ... },             // durable pointer to the element (below)
  "effect": { ... },             // what changed as a result (below)
  "suppressed": true,            // override/mask mode: intent WITHOUT firing
  "inferred": true               // heuristic-derived — see § Heuristics + Disambiguation
}
```

**OCIC command parity.** `command` is the core of every event: the exact OCIC
tool input, same names and units, so `command.input` + the event's `tab` as
tabId IS a replayable call. Coordinates are viewport px, exactly the space
OCIC's CDP dispatch and screenshots use. **Honesty rule: nothing in `command`
is invented.** Every value is taken from the observed DOM event; the one
derivation is scroll ticks (accumulated wheel px / 100, OCIC's own constant),
and commands on `inferred` events (hover, drag) are heuristic reconstructions
flagged by the event-level `inferred`. Deliberate exceptions, with reasons:

- **Perception has no events.** OCIC's screenshot / zoom / read_page / find /
  get_page_text / scroll_to have no human-side equivalent — you cannot
  instrument a person's eyes. The frames, cursor, and narration tracks are the
  perception record.
- **No `wait` events.** Gaps between consecutive `t`s ARE the waits.
- **Alt-clicks.** Alt is the recorder's override/mask key, so an alt-click is
  recorded as `suppressed` intent, never as an alt-modified click. Other
  modifiers (ctrl/shift/cmd) record 1:1.
- **`type` is the committed text** (captured on change), equivalent to one
  OCIC `type` into the focused field — not a keystroke stream. Standalone keys
  and shortcuts (Enter/Tab/Escape, ctrl/cmd combos) appear as `key` events in
  OCIC combo syntax.
- **`scroll` comes from wheel bursts** (1 tick = 100px, OCIC's own constant,
  clamped to 1..10). Scrollbar drags don't fire wheel; they surface as drags
  plus frame changes.
- **`tab_activated` has no OCIC verb** (OCIC selects tabs implicitly via the
  tabId parameter on every call); it is kept for timeline segmentation.
  `tab_opened`/`tab_closed` correspond to tabs_create_mcp / tabs_close_mcp.
- **Click bursts ascend.** A double-click records as left_click then
  double_click; a triple adds triple_click. For replay, take the LAST event of
  a same-position burst — it is the command OCIC would issue.

Drag endpoints live in `start_coordinate`/`coordinate`; the actual curve is in
the cursor track for `[t_down, t_up]`.

**`anchor`** — a durable, multi-signal pointer, resolved at capture time:
```
{ "selector", "role", "name" (accessible name), "text", "tag",
  "attrs": { id, class, "data-testid", type, name, href, "aria-*" },
  "path":  [ "<ancestor opening tag>", ... ] }
```

**`effect`** — the action→result signal (mutations in the ~700ms after):
```
{ "added": [...], "removed": [...], "textChanged": [...], "urlChanged": "..." }
```

### Track C — `cursor[]` (the raw trajectory, the gesture signal)

```
{ "t": <ms>, "x": <viewport px>, "y": <viewport px> }
```

Throttled samples of cursor position (~every 50ms while moving). This is the
pointing/circling/hesitation gesture, kept losslessly. It is **evidence, not a
command** — do not replay it point by point. Use it to see *where the operator's
attention was* (circling a group of items, pointing at one thing), and to pull
the curve behind a `left_click_drag`.

### Track D — `images[]` (frame references — what the screen looked like)

```
{ "t": <ms>, "ref": "images/00007.jpg", "w": <px>, "h": <px>, "vw": <px>, "vh": <px> }
```

A 240p screenshot of the visible tab, captured when a behavior event or cursor
activity happens, throttled to at most one per second (so it skips passive
waiting). `ref` is a path into the bundle's `images/` dir — open it only if you
want it. Frames are NOT one-per-action; resolve a behavior event or cursor point
to the image with the **nearest `t`**. A frame is the state *before* the effect
of the action it's anchored to (the effect window carries the after). `w`/`h`
are the saved frame size; `vw`/`vh` are the viewport size when it was captured —
divide a click's or cursor point's `(x, y)` by `(vw, vh)` to place it on the
frame (or to normalise into any screenshot space).

### Track B — `cognitive[]` (narration, what the operator said and why)

```
{ "t": <ms>, "end": <ms>, "text": "<what they said>" }
```

## Heuristics (read this — the inferred actions are guesses)

Two behavior actions are **not** DOM events; they are inferred from the cursor,
and every such event carries `"inferred": true`. The detector is biased toward
**false positives** — it would rather emit a hover/drag that wasn't quite
intentional than miss one — because the raw movement is in the cursor track
regardless, and because these are marked inferred so you can discount them.

| Inferred action | How it's detected | Bias |
|---|---|---|
| `hover` | Cursor dwells within ~8px for ~350ms over a specific element (not `body`/`html`), button up. One per dwell. | Liberal: a brief pause counts, so expect some incidental hovers. |
| `left_click_drag` | Button held while the cursor moves > ~8px, then released. Endpoints + time range; curve in the cursor track. | Liberal: small button-held moves count as drags. |

`left_click`, `right_click`, `double_click`, `triple_click`, `type`, `key`,
`scroll`, `navigate`, and the `tab_*` actions come from real DOM/browser events
and are **certain** (never `inferred`). Note a click burst ascends
(left_click, then double_click, then triple_click) — replay the last.

## Disambiguation — the cognitive track is the arbiter

When an `inferred` action or a cursor gesture is ambiguous — was this hover
intentional? is this cursor movement meaningful or idle? — **weigh the
narration.** The cognitive track is the ground truth of intent:

- Narration references it ("I'm hovering over the filter", "let me point at
  these three") → the inferred event / gesture is **real and important**.
- No narration and no `effect` → the inferred event is likely **incidental**;
  discount it.
- **A stretch of cursor + narration with NO behavior events is itself a signal:**
  the operator is explaining by pointing. Read the cursor track over that window
  against what they're saying — that is where the "why" lives with no click to
  anchor it.

In short: behavior says *what*, cursor says *where the attention moved*, and
**cognitive says which of those mattered.** When weighing attention or truth,
lean on the cognitive side.

## Reading it

For any moment, the behavior event says what was done, the cursor track shows
where attention was moving, and the overlapping narration says why — and
resolves whether an inferred action or a gesture was intentional. Together they
reconstruct the workflow (and let you compose a single batched automation of
it), not merely replay it.
