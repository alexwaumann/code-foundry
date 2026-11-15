import { formatSize } from "../../fileKind";
import { docOf, plainText } from "../logDoc";
import { LogBody } from "../LogBody";
import type { PreviewKind } from "../types";

/**
 * A `.log` file: Rendered | Source. Read from its end (the last MiB, readFileTail) and opened
 * at the bottom; each line's timestamp, level and fields are looked for, and its ANSI colours
 * shown. Rendered copies the text without escape sequences (what the view shows), Source the
 * text as written.
 */
const log: PreviewKind = {
  id: "log",
  match: { ext: ["log"] },
  modes: [{ id: "rendered", label: "Rendered" }],
  read: "tail",
  Body: LogBody,
  meta: ({ file }) => {
    const n = docOf(file, true).lines;
    return `${String(n)} ${n === 1 ? "line" : "lines"} · ${formatSize(file.size)} · Log`;
  },
  wrap: true,
  copy: ({ file }) => plainText(file.text ?? ""),
};

export default log;
