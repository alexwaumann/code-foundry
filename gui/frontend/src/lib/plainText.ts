/**
 * Text a thread wrote, for a place that is not the thread's: a note, a thread's name. A model's
 * input can be written by anyone, so this text gets no layout of its own: one paragraph, its
 * white space collapsed, with no control, format or bidi characters and no towers of combining
 * marks. internal/command plainNote does the same to a note on its way in. Pure.
 */
export function plainLine(s: string): string {
  return s
    .replace(/[^\P{C}\s]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/(\p{M}{3})\p{M}+/gu, "$1")
    .trim();
}

/** plainLine, cut to `max` characters. */
export function plainName(s: string, max = 48): string {
  const chars = Array.from(plainLine(s));
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : chars.join("");
}
