// Imitation-learning trace schema — version 0.
//
// The trace is TWO parallel tracks on ONE epoch clock, never one merged
// sequence: behavior and narration overlap (you talk while you act), so
// flattening them would destroy ordering information. A viewer aligns them on
// the clock; the agent reads both.
//
// This module is dependency-free and runs unchanged in the extension
// (content script / offscreen / service worker) and in Node (the stop
// pipeline and tests).

export const SCHEMA_VERSION = "v0";

// ---- Track A: behavior -----------------------------------------------------
// One entry per captured interaction. Grounded in OCIC's computer-tool verbs.
export const ACTIONS = Object.freeze({
  LEFT_CLICK: "left_click",
  RIGHT_CLICK: "right_click",
  DOUBLE_CLICK: "double_click",
  TRIPLE_CLICK: "triple_click",
  HOVER: "hover", // inferred: a brief dwell over an element
  LEFT_CLICK_DRAG: "left_click_drag", // inferred: button-held move; endpoints + time range
  TYPE: "type",
  KEY: "key",
  SCROLL: "scroll",
  NAVIGATE: "navigate",
  TAB_ACTIVATED: "tab_activated", // segmentation: operator switched tabs
  TAB_OPENED: "tab_opened",
  TAB_CLOSED: "tab_closed"
});
// Raw cursor trajectory (Layer 2) lives in its own track, not as behavior
// events — see the cursor field on the trace. mouse_move is intentionally NOT
// a behavior action; the trajectory is the cursor track.

/**
 * A behavior event. `t` is ms since trace.started_at (the shared clock).
 * Every event is namespaced by (tab, frame) because each document numbers its
 * own DOM nodes independently — never assume a global id space.
 *
 * @param {object} o
 * @param {number} o.t            ms since started_at
 * @param {number} o.tab          chrome tabId
 * @param {number} [o.frame=0]    frameId
 * @param {string} o.action       one of ACTIONS
 * @param {object} [o.anchor]     durable semantic anchor (see makeAnchor)
 * @param {object} [o.effect]     pre/post DOM-effect summary
 * @param {*}      [o.value]      typed text, scroll delta, key, url, etc.
 * @param {boolean}[o.suppressed] true when captured in override/mask mode
 * @param {string} [o.screenshot] optional bundle-relative screenshot path
 */
export function makeBehaviorEvent(o) {
  const e = {
    t: o.t,
    tab: o.tab,
    frame: o.frame ?? 0,
    action: o.action
  };
  // THE CORE KEY: the exact OCIC tool input that reproduces this event
  // ({ tool, input }); viewport-px space. Absent only where no OCIC verb
  // exists (tab_activated). Everything else on the event is enrichment.
  if (o.command) e.command = o.command;
  for (const k of ["url", "t_down", "t_up"]) {
    if (o[k] !== undefined) e[k] = o[k]; // context / timing enrichments
  }
  if (o.anchor) e.anchor = o.anchor;
  if (o.effect) e.effect = o.effect;
  if (o.value !== undefined) e.value = o.value;
  if (o.suppressed) e.suppressed = true;
  if (o.inferred) e.inferred = true; // heuristic-derived (hover, drag)
  if (o.screenshot) e.screenshot = o.screenshot;
  return e;
}

/**
 * A DURABLE semantic anchor. Resolved at capture time from the live element,
 * because ephemeral per-session node ids are useless to an agent later.
 * Everything downstream keys off selector + role + name + text, never an id.
 */
export function makeAnchor({ selector, role, name, text, tag, attrs, path }) {
  const a = {};
  if (selector) a.selector = selector;
  if (role) a.role = role;
  if (name) a.name = name; // accessible name
  if (text) a.text = text.slice(0, 120); // visible text, bounded
  if (tag) a.tag = tag;
  if (attrs) a.attrs = attrs; // { id, class, "data-testid", type, name, href, aria-* }
  if (path) a.path = path; // ancestor chain of cleaned opening tags (location context)
  return a;
}

/**
 * A pre/post DOM-effect summary: what changed as a result of the action.
 * This is the action->result signal an agent learns from (rrweb-style
 * mutation delta, but bounded and semantic rather than a full replay stream).
 */
export function makeEffect({ added, removed, textChanged, urlChanged }) {
  const e = {};
  if (added && added.length) e.added = added.slice(0, 8); // brief descriptors
  if (removed && removed.length) e.removed = removed.slice(0, 8);
  if (textChanged && textChanged.length) e.textChanged = textChanged.slice(0, 8);
  if (urlChanged) e.urlChanged = urlChanged;
  return e;
}

// ---- Track B: cognitive (narration) ---------------------------------------
/**
 * An utterance span from the transcript. `t`/`end` are ms since started_at.
 */
export function makeUtterance({ t, end, text }) {
  return { t, end, text };
}

// ---- The trace -------------------------------------------------------------
export function newTrace(startedAt, session) {
  return {
    schema: SCHEMA_VERSION,
    recording_id: session.recording_id,
    started_at: startedAt, // epoch ms — the shared zero for all tracks
    ended_at: null,
    url0: session.url0 ?? null, // first URL, for quick context
    behavior: [], // Track A — discrete events (clicks, type, nav, hover, drag)
    cursor: [], // Track C — raw cursor trajectory [{t,x,y}] (the gesture signal)
    images: [], // Track D — frame references [{t,ref,w,h}] into the images/ dir
    cognitive: [] // Track B — narration (filled at stop from the transcript)
  };
}

// Cursor points arrive as epoch-stamped {t,x,y}; convert to the shared clock.
export function cursorToTrack(points, traceStartedAt) {
  return (points || [])
    .map((p) => ({ t: Math.round(p.t - traceStartedAt), x: p.x, y: p.y }))
    .filter((p) => p.t >= 0)
    .sort((a, b) => a.t - b.t);
}

// Image refs arrive epoch-stamped; convert to the shared clock. Each is a
// pointer into the bundle's images/ dir — the agent (or viewer) reads the file
// only if it wants it. w/h are the captured frame size, for coordinate mapping.
export function imagesToTrack(images, traceStartedAt) {
  return (images || [])
    .map((im) => ({
      t: Math.round(im.t - traceStartedAt),
      ref: im.ref,
      w: im.w,
      h: im.h,
      vw: im.vw, // viewport the frame was captured at (for mapping cursor x/y)
      vh: im.vh
    }))
    .filter((im) => im.t >= 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Collapse Whisper segments into Track B utterances, offsetting to the shared
 * clock. `audioStartedAt` is the epoch ms when audio capture began (may differ
 * slightly from trace.started_at); `segments` are Whisper verbose_json
 * segments with start/end in seconds relative to the audio.
 */
export function segmentsToCognitive(segments, audioStartedAt, traceStartedAt) {
  const offsetMs = audioStartedAt - traceStartedAt; // align audio to trace zero
  return (segments || [])
    .map((s) =>
      makeUtterance({
        t: Math.round(s.start * 1000 + offsetMs),
        end: Math.round(s.end * 1000 + offsetMs),
        text: (s.text || "").trim()
      })
    )
    // Drop anything that lands entirely before the trace zero — that's the mic
    // warm-up window (offsetMs is negative), which carries no real narration.
    .filter((u) => u.end > 0)
    .map((u) => (u.t < 0 ? { ...u, t: 0 } : u));
}
