import { highlightParts } from "./model";

/** Text with the search words marked; plain text without words. */
export function Highlight({ text, words }: { text: string; words?: readonly string[] | undefined }) {
  if (!words || words.length === 0) return text;
  return highlightParts(text, words).map((p, i) =>
    p.hit ? (
      <mark key={i} className="rounded-sm bg-warning/25 text-inherit">
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}
