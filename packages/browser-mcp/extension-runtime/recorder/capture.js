// Content-script capturer — injected into every frame of every tab
// (all_frames, document_start). Captures Track A (behavior) as durable
// semantic anchors + pre/post effect windows, and forwards events to the
// service worker, which routes them to the offscreen buffer.
//
// Event-driven: we only emit on real interaction (click, input, key, scroll,
// navigation). A quiet stretch produces no events and shows as a gap on the
// timeline — that is the intended "nothing to record" behavior.
//
// NEEDS LIVE TESTING (Chrome). Anchor resolution reuses ideas from content.js.

(function () {
  if (window.__ocicRecorderLoaded) return;
  window.__ocicRecorderLoaded = true;

  const OVERRIDE_KEY = "altKey"; // Alt/Option = override/mask mode (§8)
  let recording = false;

  // --- Heuristic thresholds (documented in SCHEMA_v0.md § Heuristics) --------
  // Bias: FALSE POSITIVES over false negatives. The cursor track keeps the raw
  // trajectory losslessly, so a missed hover loses nothing; and inferred events
  // are flagged so the reading agent treats them as guesses to cross-check, not
  // confident facts. So these thresholds are deliberately LOW.
  const HOVER_DWELL_MS = 350; // a brief pause (not a dead stop) counts as hover
  const HOVER_MOVE_EPS = 8; // px; movement beyond this restarts the dwell
  const DRAG_MIN_PX = 8; // button-held movement beyond this is a drag, not a click
  const CURSOR_SAMPLE_MS = 50; // throttle raw cursor sampling
  const CURSOR_BATCH_MAX = 40; // flush the cursor batch at this many points
  const CURSOR_FLUSH_MS = 700; // ...or at least this often

  // The service worker tells us when a recording is active.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.__ocic === "recording_state") recording = !!msg.on;
  });
  // Ask on load in case we were injected mid-recording (new tab during a session).
  try {
    chrome.runtime.sendMessage({ __ocic: "recorder_hello" }, (r) => {
      if (chrome.runtime.lastError) return;
      if (r && typeof r.on === "boolean") recording = r.on;
    });
  } catch {}

  // ---- durable anchor resolution -------------------------------------------
  const TAG_ROLE = {
    a: "link", button: "button", input: "textbox", textarea: "textbox",
    select: "combobox", img: "img"
  };
  const SEMANTIC_ATTRS = [
    "id", "class", "role", "type", "name", "href", "placeholder",
    "data-testid", "data-test", "aria-label", "aria-labelledby"
  ];

  function accessibleName(el) {
    return (
      el.getAttribute("aria-label") ||
      (el.getAttribute("aria-labelledby") &&
        document.getElementById(el.getAttribute("aria-labelledby"))?.textContent?.trim()) ||
      el.getAttribute("title") ||
      el.getAttribute("alt") ||
      (el.tagName === "INPUT" && el.labels?.[0]?.textContent?.trim()) ||
      el.textContent?.trim().slice(0, 80) ||
      ""
    );
  }

  function pickAttrs(el) {
    const out = {};
    for (const a of SEMANTIC_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) out[a] = v.length > 80 ? v.slice(0, 80) : v;
    }
    return out;
  }

  // A stable-ish CSS selector: prefer id, then data-testid, then a scoped
  // path. Not guaranteed unique across redesigns, but the anchor also carries
  // role/name/text so the agent has multiple ways to relocate the element.
  function cssSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testid = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (testid) return `${el.tagName.toLowerCase()}[data-testid="${testid}"]`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      if (node.getAttribute("role")) part += `[role="${node.getAttribute("role")}"]`;
      const sibs = node.parentNode
        ? [...node.parentNode.children].filter((c) => c.tagName === node.tagName)
        : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      parts.unshift(part);
      if (node.id) { parts[0] = `#${CSS.escape(node.id)}`; break; }
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // The ancestor path: cleaned opening tags up the tree (location context).
  // §13-E showed this is ~150-300 tokens vs 75k for full HTML.
  function ancestorPath(el, depth = 6) {
    const path = [];
    let node = el.parentElement;
    while (node && node.nodeType === 1 && path.length < depth) {
      let tag = `<${node.tagName.toLowerCase()}`;
      const id = node.id ? ` id="${node.id}"` : "";
      const role = node.getAttribute("role") ? ` role="${node.getAttribute("role")}"` : "";
      const cls = node.getAttribute("class")
        ? ` class="${node.getAttribute("class").slice(0, 40)}"`
        : "";
      path.unshift(tag + id + role + cls + ">");
      node = node.parentElement;
    }
    return path;
  }

  function resolveAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    return {
      selector: cssSelector(el),
      role: el.getAttribute("role") || TAG_ROLE[el.tagName.toLowerCase()] || undefined,
      name: accessibleName(el) || undefined,
      text: el.textContent?.trim().slice(0, 120) || undefined,
      tag: el.tagName.toLowerCase(),
      attrs: pickAttrs(el),
      path: ancestorPath(el)
    };
  }

  // ---- pre/post effect window ----------------------------------------------
  // The action->result signal: what mutated in the ~700ms after an action.
  // Scoped and bounded, not a full replay stream.
  function captureEffect(afterFn) {
    const added = [];
    const removed = [];
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && added.length < 8) added.push(describeNode(n));
        }
        for (const n of r.removedNodes) {
          if (n.nodeType === 1 && removed.length < 8) removed.push(describeNode(n));
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const urlBefore = location.href;
    setTimeout(() => {
      obs.disconnect();
      const effect = {};
      if (added.length) effect.added = added;
      if (removed.length) effect.removed = removed;
      if (location.href !== urlBefore) effect.urlChanged = location.href;
      afterFn(effect);
    }, 700);
  }

  function describeNode(n) {
    const role = n.getAttribute?.("role");
    const label = n.getAttribute?.("aria-label") || n.textContent?.trim().slice(0, 40);
    return `${n.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${label ? ` ${label}` : ""}`;
  }

  // ---- emit ----------------------------------------------------------------
  function emit(action, el, extra) {
    if (!recording) return;
    const suppressed = extra && extra.suppressed;
    const base = {
      __ocic: "behavior_event",
      t: (extra && extra.t) || Date.now(), // epoch; SW subtracts started_at
      vw: window.innerWidth, // viewport at capture — lets frames map cursor x/y
      vh: window.innerHeight,
      action,
      anchor: el ? resolveAnchor(el) : undefined,
      suppressed: suppressed || undefined,
      // inferred = derived by a heuristic (hover, left_click_drag), not a DOM
      // event. The reading agent should treat these as guesses and cross-check
      // against the cursor track, effect window, and narration.
      inferred: (extra && extra.inferred) || undefined,
      value: extra && extra.value
    };
    // THE CORE KEY: `command` is the exact OCIC tool input that reproduces
    // this event — 1:1 field names, units, and coordinate space (viewport px,
    // which is what OCIC dispatches over CDP). Every tool also takes tabId:
    // use the event's `tab`. Nothing here is invented: values come from the
    // observed DOM event; commands on `inferred` events are heuristic
    // reconstructions and are flagged as such at the event level.
    const COMPUTER_ACTIONS = new Set([
      "left_click", "right_click", "double_click", "triple_click", "hover",
      "left_click_drag", "type", "key", "scroll"
    ]);
    const input = {};
    for (const k of ["coordinate", "start_coordinate", "modifiers", "text",
                     "scroll_direction", "scroll_amount"]) {
      if (extra && extra[k] !== undefined) input[k] = extra[k];
    }
    if (COMPUTER_ACTIONS.has(action)) {
      base.command = { tool: "computer", input: { action, ...input } };
    }
    // Recorder timing enrichment for drags (not OCIC params): the cursor
    // track holds the actual curve for [t_down, t_up].
    if (extra && extra.t_down !== undefined) base.t_down = extra.t_down;
    if (extra && extra.t_up !== undefined) base.t_up = extra.t_up;
    if (
      !suppressed &&
      (action === "left_click" || action === "type" || action === "key" || action === "left_click_drag")
    ) {
      captureEffect((effect) => {
        if (Object.keys(effect).length) base.effect = effect;
        send(base);
      });
    } else {
      send(base);
    }
  }

  function send(evt) {
    try {
      chrome.runtime.sendMessage(evt, () => void chrome.runtime.lastError);
    } catch {}
  }

  // ---- cursor track (Layer 2) + pointer heuristics -------------------------
  // The cursor track captures the RAW trajectory (all movement, throttled) so
  // the pointing/circling gesture survives losslessly. hover and left_click_drag
  // are inferred landmarks derived from it; they're flagged `inferred`.
  let cursorBatch = [];
  let lastSample = 0;
  function flushCursor() {
    if (!cursorBatch.length) return;
    const points = cursorBatch;
    cursorBatch = [];
    try {
      chrome.runtime.sendMessage(
        { __ocic: "cursor_batch", points, vw: window.innerWidth, vh: window.innerHeight },
        () => void chrome.runtime.lastError
      );
    } catch {}
  }
  setInterval(() => { if (recording) flushCursor(); }, CURSOR_FLUSH_MS);

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const NONHOVER = new Set(["BODY", "HTML"]);
  const isHoverWorthy = (el) => el && el.nodeType === 1 && !NONHOVER.has(el.tagName);

  let downPt = null; // pointerdown state {x,y,el,t}
  let dragging = false;
  let justDragged = 0; // ts of last drag, to drop the trailing synthetic click
  let dwellPt = null; // current hover-dwell anchor {x,y}
  let dwellTimer = null;
  let hoveredEl = null; // element already emitted for this dwell

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!recording || e.button !== 0) return;
      downPt = { x: e.clientX, y: e.clientY, el: e.target, t: Date.now() };
      dragging = false;
      clearTimeout(dwellTimer);
      dwellPt = null;
      hoveredEl = null; // no hover while a button is held
    },
    true
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (!recording) return;
      const now = Date.now();
      const p = { x: e.clientX, y: e.clientY };
      // (1) raw cursor track — sample all movement, throttled
      if (now - lastSample >= CURSOR_SAMPLE_MS) {
        lastSample = now;
        cursorBatch.push({ t: now, x: Math.round(p.x), y: Math.round(p.y) });
        if (cursorBatch.length >= CURSOR_BATCH_MAX) flushCursor();
      }
      // (2) drag detection while a button is held
      if (downPt) {
        if (!dragging && dist(downPt, p) > DRAG_MIN_PX) dragging = true;
        return; // no hover mid-press
      }
      // (3) hover dwell — restart on movement, emit after a brief pause
      if (!dwellPt || dist(dwellPt, p) > HOVER_MOVE_EPS) {
        dwellPt = p;
        hoveredEl = null;
        clearTimeout(dwellTimer);
        dwellTimer = setTimeout(() => {
          const el = document.elementFromPoint(p.x, p.y);
          if (el && el !== hoveredEl && isHoverWorthy(el)) {
            hoveredEl = el;
            emit("hover", el, { inferred: true, coordinate: [p.x, p.y] });
          }
        }, HOVER_DWELL_MS);
      }
    },
    true
  );

  document.addEventListener(
    "pointerup",
    (e) => {
      if (!recording || !downPt) return;
      if (dragging) {
        justDragged = Date.now();
        const from = downPt;
        // Anchor on the drop target; keep endpoints + the time range so the
        // actual curve can be pulled from the cursor track for [t_down, t_up].
        emit("left_click_drag", e.target, {
          inferred: true,
          start_coordinate: [from.x, from.y], // OCIC's drag params, 1:1
          coordinate: [e.clientX, e.clientY],
          t_down: from.t, // recorder timing enrichment: the curve for
          t_up: Date.now() // [t_down, t_up] lives in the cursor track
        });
      }
      downPt = null;
      dragging = false;
    },
    true
  );

  // OCIC-syntax modifier string ("ctrl+shift+cmd"). Alt is EXCLUDED on clicks:
  // the recorder reserves Alt as the override/mask key, so an alt-click records
  // suppressed intent, never an alt-modified click (documented exception).
  function modStr(e, withAlt) {
    const m = [];
    if (e.ctrlKey) m.push("ctrl");
    if (withAlt && e.altKey) m.push("alt");
    if (e.shiftKey) m.push("shift");
    if (e.metaKey) m.push("cmd");
    return m.length ? m.join("+") : undefined;
  }

  // ---- discrete DOM events (certain — never flagged inferred) ---------------
  document.addEventListener(
    "click",
    (e) => {
      if (!recording) return;
      if (Date.now() - justDragged < 200) return; // the pointerup was a drag
      if (e[OVERRIDE_KEY]) {
        // Override/mask mode: record the intent, suppress the real click.
        e.preventDefault();
        e.stopPropagation();
        emit("left_click", e.target, { suppressed: true, coordinate: [e.clientX, e.clientY] });
        return;
      }
      // Click-count discrimination, mirroring OCIC's distinct commands: a
      // rapid burst ascends left_click (detail 1) → double_click (the dblclick
      // listener) → triple_click (detail 3). Replay takes the last of a burst.
      if (e.detail >= 3) {
        emit("triple_click", e.target, { coordinate: [e.clientX, e.clientY], modifiers: modStr(e) });
        return;
      }
      if (e.detail === 2) return; // the dblclick listener emits double_click
      emit("left_click", e.target, { coordinate: [e.clientX, e.clientY], modifiers: modStr(e) });
    },
    true
  );

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (recording) emit("right_click", e.target, { coordinate: [e.clientX, e.clientY], modifiers: modStr(e) });
    },
    true
  );

  document.addEventListener(
    "dblclick",
    (e) => {
      if (recording) emit("double_click", e.target, { coordinate: [e.clientX, e.clientY], modifiers: modStr(e) });
    },
    true
  );

  document.addEventListener(
    "keydown",
    (e) => {
      if (!recording) return;
      // Meaningful keys (Enter/Tab/Escape/shortcuts) — typed text is captured
      // on `change` as a value, not per keystroke.
      if (["Enter", "Tab", "Escape"].includes(e.key) || e.metaKey || e.ctrlKey) {
        // OCIC key syntax: lowercase modifiers + key, e.g. "cmd+a", "Enter".
        const mods = modStr(e, true);
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        emit("key", e.target, { text: mods ? mods + "+" + k : k });
      }
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      if (!recording) return;
      const el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) {
        emit("type", el, { text: (el.value || "").slice(0, 200) });
      }
    },
    true
  );

  // Scroll is recorded as the OCIC scroll command: pointer coordinate +
  // direction + wheel ticks, accumulated per burst. 1 tick = 100px of delta —
  // the exact inverse of OCIC's dispatch constant — clamped to OCIC's 1..10.
  // (Scrollbar drags don't fire wheel; they surface as drags + frame changes.)
  let wheelAcc = null;
  let wheelTimer = null;
  document.addEventListener(
    "wheel",
    (e) => {
      if (!recording) return;
      if (!wheelAcc)
        wheelAcc = { x: e.clientX, y: e.clientY, dx: 0, dy: 0, el: e.target, t: Date.now() };
      wheelAcc.dx += e.deltaX;
      wheelAcc.dy += e.deltaY;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        const a = wheelAcc;
        wheelAcc = null;
        if (!a) return;
        const vert = Math.abs(a.dy) >= Math.abs(a.dx);
        const px = vert ? a.dy : a.dx;
        if (!px) return;
        emit("scroll", a.el, {
          t: a.t,
          coordinate: [a.x, a.y],
          scroll_direction: vert ? (px > 0 ? "down" : "up") : (px > 0 ? "right" : "left"),
          scroll_amount: Math.max(1, Math.min(10, Math.round(Math.abs(px) / 100)))
        });
      }, 300);
    },
    { capture: true, passive: true }
  );
})();
