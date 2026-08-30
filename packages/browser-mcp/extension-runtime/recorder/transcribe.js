// Speech-to-text at the OCIC level. Runs in the offscreen document (which can
// fetch) at stop-time, over the saved audio.
//
// The audio is recorded as a series of independently-decodable segments (see
// offscreen.js), so this module only ever sees one bounded segment at a time —
// it never has to slice a container it can't parse. Each segment is one API
// call, well under OpenAI's 25MB cap.
//
// Dependency-free (uses fetch + FormData, present in the offscreen document
// and in Node 18+), so it is unit-testable outside the browser.

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

// OpenAI rejects uploads above this. Segment rotation keeps every piece an
// order of magnitude below it; this is the last line of defence, and it fails
// with a message that names the real cause instead of an opaque 4xx.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

/**
 * Turn an API failure into one short clause an operator can act on. This text
 * ends up in the badge tooltip, in trace.json, and in the clipboard reference,
 * so it has to read as a cause and not as a stack trace.
 */
export function describeFailure(status, body) {
  const b = String(body || "");
  if (/insufficient_quota|credit_balance_exhausted/i.test(b))
    return "the OpenAI account has no credits left";
  if (/model_not_found|does not have access/i.test(b))
    return "this OpenAI key cannot access whisper-1";
  if (status === 401) return "the OpenAI API key is invalid";
  if (status === 429) return "OpenAI rate-limited the request";
  if (status === 413) return "the audio segment was rejected as too large";
  if (status >= 500) return `OpenAI had a server error (${status})`;
  if (status) return `OpenAI returned ${status}`;
  return "the request to OpenAI failed";
}

// A short silent WAV, built by hand so the capability probe needs no assets.
function silentWav(seconds = 0.3, rate = 8000) {
  const n = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ascii = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Check that this key can ACTUALLY transcribe, before a recording is allowed
 * to start. Deliberately not a /v1/models call: that endpoint returns 200 for
 * a key with an exhausted credit balance, which is the single most likely way
 * to lose a narration track. Authentication is not capability — the only way
 * to know transcription works is to transcribe something.
 *
 * Costs a fraction of a cent (a 0.3s clip) once per recording start.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function validateOpenAiKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { ok: false, error: "No API key provided." };
  }
  const form = new FormData();
  form.append("file", silentWav(), "probe.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  try {
    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      body: form
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, error: describeFailure(res.status, body) };
  } catch (e) {
    return { ok: false, error: `could not reach OpenAI (${e.message})` };
  }
}

/**
 * Transcribe one audio segment with word + segment timestamps.
 * Retries transient failures (rate limit, 5xx) with backoff; a permanent
 * failure (bad key, no credits) throws immediately rather than burning time.
 * @returns {Promise<{ text, duration, words, segments }>}
 */
export async function transcribe(audio, apiKey, { filename = "audio.webm" } = {}) {
  const blob =
    audio instanceof Blob ? audio : new Blob([audio], { type: "audio/webm" });
  if (blob.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `the audio segment was ${(blob.size / 1048576).toFixed(1)}MB, over OpenAI's 25MB limit`
    );
  }

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    let res;
    try {
      res = await fetch(OPENAI_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        body: form
      });
    } catch (e) {
      lastErr = new Error(`could not reach OpenAI (${e.message})`);
      continue; // network blips are worth a retry
    }
    if (res.ok) {
      const data = await res.json();
      return {
        text: data.text || "",
        duration: data.duration ?? null,
        words: data.words || [],
        segments: data.segments || []
      };
    }
    const body = await res.text().catch(() => "");
    lastErr = new Error(describeFailure(res.status, body));
    if (!RETRY_STATUS.has(res.status)) throw lastErr; // permanent: stop now
  }
  throw lastErr || new Error("transcription failed");
}
