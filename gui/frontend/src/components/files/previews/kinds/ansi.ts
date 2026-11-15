import { getFiletypeFromFileName } from "@pierre/diffs";
import { formatSize } from "../../fileKind";
import { hasAnsi } from "../ansi";
import { docOf, plainText } from "../logDoc";
import { AnsiBody } from "../LogBody";
import type { PreviewKind } from "../types";

/**
 * Captured terminal output (a `.txt` or `.out` with colour codes): Rendered | Source, the log
 * view without levels or timestamps, so nothing in the text is reinterpreted. Matched by a
 * sniff (one scan for "ESC["), and only in a file the highlighter calls plain text: a script
 * or source file with an escape in it stays code. Read whole, opened at the bottom.
 */
const ansi: PreviewKind = {
  id: "ansi",
  match: { sniff: hasAnsi },
  shows: (f) => f.text !== null && getFiletypeFromFileName(f.path) === "text",
  modes: [{ id: "rendered", label: "Rendered" }],
  Body: AnsiBody,
  meta: ({ file }) => {
    const n = docOf(file, false).lines;
    return `${String(n)} ${n === 1 ? "line" : "lines"} · ${formatSize(file.size)} · Terminal output`;
  },
  wrap: true,
  copy: ({ file }) => plainText(file.text ?? ""),
};

export default ansi;
