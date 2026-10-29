/**
 * Dictation's pure helpers (docs/notes/dictation-4-gui.md): where a phrase lands, the
 * listening pill's level bars and clock, and the settings section's sizes.
 */

/**
 * A phrase as inserted at a caret with `before` and `after` around it (the paragraph's
 * text on either side): trimmed, a space in front unless the caret is at the start of the
 * line or after whitespace, and one after only when a word follows straight on. Its
 * capitalisation is the engine's. "" for a blank phrase.
 */
export function phraseAtCaret(text: string, before: string, after = ""): string {
  const t = text.trim();
  if (t === "") return "";
  const lead = before !== "" && !/\s$/.test(before) ? " " : "";
  const trail = /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  return `${lead}${t}${trail}`;
}

/** What the denied line's link opens: System Settings at Privacy & Security › Microphone. */
export const MIC_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
/** The prompt's placeholder while a composer dictates. */
export const LISTENING_PLACEHOLDER = "Listening…";

/** The listening pill's bars. */
export const LEVEL_BARS = 7;
/** How fast a bar falls back without new levels: it halves in this many ms. */
export const LEVEL_HALF_LIFE_MS = 140;

/** A level event's rms (0..1) as a bar's height fraction (0..1): speech sits around 0.02 to 0.2, so the root spreads it out. */
export function levelOf(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(1, Math.sqrt(rms) * 2.2);
}

/** The bars after a new level: they move one to the left and the new one enters on the right. */
export function pushLevel(bars: readonly number[], rms: number): number[] {
  const next = bars.slice(-(LEVEL_BARS - 1));
  while (next.length < LEVEL_BARS - 1) next.unshift(0);
  next.push(levelOf(rms));
  return next;
}

/** The bars `dtMs` later without a new level: each falls with LEVEL_HALF_LIFE_MS; tiny values become 0. */
export function decayLevels(bars: readonly number[], dtMs: number): number[] {
  const k = 0.5 ** (Math.max(0, dtMs) / LEVEL_HALF_LIFE_MS);
  return bars.map((v) => {
    const d = v * k;
    return d < 0.01 ? 0 : d;
  });
}

/** A bar's height in px: 3 at rest, 14 at full level (the sketch's range). */
export function barHeight(v: number): number {
  return 3 + Math.round(Math.min(1, Math.max(0, v)) * 11);
}

/** Elapsed listening time as m:ss ("0:04", "12:30"). */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, "0")}`;
}

/** Bytes as whole decimal megabytes, like the daemon's messages ("557 MB"). */
export function megabytes(bytes: number): string {
  return `${String(Math.floor(bytes / 1_000_000))} MB`;
}

/** Bytes as decimal gigabytes to one place ("0.9 GB"): the download button. */
export function gigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** hw.memsize as the GB a Mac is sold with ("16 GB"). */
export function memorySize(bytes: number): string {
  return `${String(Math.round(bytes / 2 ** 30))} GB`;
}

/** "557 MB of 874 MB · 11 MB/s"; the speed is left out until known. */
export function downloadProgress(received: number, total: number, bytesPerSecond: number): string {
  const head = `${megabytes(received)} of ${megabytes(total)}`;
  return bytesPerSecond > 0 ? `${head} · ${megabytes(bytesPerSecond)}/s` : head;
}
