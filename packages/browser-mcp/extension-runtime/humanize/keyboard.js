// Keystroke timing + the OS typematic (auto-repeat) model.
//
// Two hard requirements, and they pull in opposite directions:
//
//   1. TYPED TEXT MUST BE EXACTLY WHAT WAS ASKED FOR. Typing is unforgiving:
//      a click that lands 3px off still hits the button, but a doubled or
//      dropped character is silent corruption. So insertion stays on
//      Input.insertText (exactly-once, unchanged from the non-humanized path)
//      and the key events we add around it are deliberately NON-text-producing
//      (rawKeyDown, not keyDown-with-text). Timing can never alter the text.
//
//   2. THE EVENT STREAM MUST LOOK LIKE THE OS PRODUCED IT. A key held past the
//      typematic initial delay with NO repeat events is just as anomalous as
//      spurious repeats — it says the input never went through an OS input
//      stack. So we honour the model rather than ignoring it:
//         short hold  (< initial delay) -> one keydown, one keyup, no repeat
//         long hold   (> initial delay) -> keydown, delay, autoRepeat keydowns
//                                          at the typematic rate, then keyup
//      Normal typing NEVER holds a key that long, so hold dwell is sampled
//      strictly BELOW the initial delay: "no repeat" is then both correct and
//      OS-consistent. A dwell can never land in the contradictory middle.

import { clamp } from "./rng.js";

// Typematic parameters are user-configurable in every OS, so the exact values
// vary per machine — the STRUCTURE is what must hold. Jittered per session so
// we don't pin one signature.
export function typematic(rng) {
  return {
    initialDelayMs: rng.uniform(280, 520), // before auto-repeat kicks in
    repeatMs: rng.uniform(24, 38)          // interval between repeats
  };
}

/** Longest a key may be held while typing — safely under the repeat threshold. */
export function keyHoldMs(rng, tm, persona) {
  const ceiling = tm.initialDelayMs * 0.45; // never approach the repeat point
  return Math.round(clamp(rng.logNormal(62 * persona.typeTempo, 1.3), 22, ceiling));
}

/**
 * Gap before the next character. Right-skewed, with the structure real typing
 * has: a floor, a long tail, longer after word/sentence boundaries, and the
 * occasional genuine "thinking" pause.
 */
export function interKeyMs(rng, prevChar, persona) {
  let median = 108 * persona.typeTempo;
  if (prevChar === " ") median *= 1.35;                  // between words
  if (prevChar && ".,;:!?".includes(prevChar)) median *= 1.7; // after punctuation
  let ms = rng.logNormal(median, 1.42);
  if (rng.chance(0.035)) ms += rng.uniform(240, 700);    // hesitation
  return Math.round(clamp(ms, 28, 1100));
}

// Characters that need a shifted keystroke — affects `code`, and real typing
// holds shift across them.
const SHIFTED = new Set(
  '~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split("")
);
const CODE_PUNCT = {
  " ": "Space", "-": "Minus", "_": "Minus", "=": "Equal", "+": "Equal",
  "[": "BracketLeft", "{": "BracketLeft", "]": "BracketRight", "}": "BracketRight",
  "\\": "Backslash", "|": "Backslash", ";": "Semicolon", ":": "Semicolon",
  "'": "Quote", '"': "Quote", ",": "Comma", "<": "Comma", ".": "Period",
  ">": "Period", "/": "Slash", "?": "Slash", "`": "Backquote", "~": "Backquote",
  // Shifted digits. Easy to overlook because they are punctuation, but they
  // sit on the number row — "!" is Digit1 with shift, not its own key. Without
  // these, common text ("hi!", any email address via "@") fell back to
  // insertText with NO key events, which is the exact signal humanized typing
  // exists to produce. Caught by the executor test.
  "!": "Digit1", "@": "Digit2", "#": "Digit3", "$": "Digit4", "%": "Digit5",
  "^": "Digit6", "&": "Digit7", "*": "Digit8", "(": "Digit9", ")": "Digit0"
};
// Digits share their keyCode with the unshifted number key.
const SHIFTED_DIGIT_KEYCODE = {
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53,
  "^": 54, "&": 55, "*": 56, "(": 57, ")": 48
};

/**
 * The `code`/`keyCode` a real keyboard would report for a character. Getting
 * these right matters for pages that read event.code or event.keyCode; when we
 * can't map a character (emoji, CJK, anything off a US layout) we return null
 * and the planner emits insertText alone — the same path used today — rather
 * than inventing a bogus key identity.
 */
export function keyDescriptor(ch) {
  if (!ch || ch.length !== 1) return null;
  const upper = ch.toUpperCase();
  if (ch >= "a" && ch <= "z") {
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), shift: false };
  }
  if (ch >= "A" && ch <= "Z") {
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), shift: true };
  }
  if (ch >= "0" && ch <= "9") {
    return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  }
  if (CODE_PUNCT[ch]) {
    // keyCode for punctuation is layout-dependent; 0 is safer than a wrong
    // guess, and pages that care overwhelmingly read `key`/`code`. The shifted
    // digits are the exception — those keyCodes are the number-row keys.
    const keyCode =
      ch === " " ? 32 : SHIFTED_DIGIT_KEYCODE[ch] !== undefined ? SHIFTED_DIGIT_KEYCODE[ch] : 0;
    return { code: CODE_PUNCT[ch], keyCode, shift: SHIFTED.has(ch) };
  }
  return null; // unmappable -> insertText only
}
