import { cn } from "@/lib/utils";
import { sgrCss, type AnsiLine } from "./ansi";

/** One parsed log line (ansi.ts): its spans in the theme's terminal colours. */
export function AnsiText({ line }: { line: AnsiLine }) {
  if (line.spans === null) return line.text || " ";
  if (line.text === "" && line.spans.every((s) => s.text === "")) return " ";
  return line.spans.map((s, i) =>
    s.style === null ? (
      s.text
    ) : (
      <span
        key={i}
        className={cn(s.style.bold && "font-bold", s.style.dim && "opacity-60", s.style.italic && "italic", s.style.underline && "underline")}
        style={sgrCss(s.style)}
        data-sgr
      >
        {s.text}
      </span>
    ),
  );
}
