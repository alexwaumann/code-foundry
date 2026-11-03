/**
 * Writes the rendered text fixture the daemon and the GUI share
 * (internal/store/thread/testdata/rendered_text.json, docs/notes/search-5-agent-daemon.md):
 * each case's `text` is what lib/markdownText makes of its `markdown`. The daemon's
 * renderedText (internal/store/thread/search_render.go) must read each case the same way
 * (white space runs aside), and src/lib/markdownText.test.tsx checks the file still matches
 * markdownText and the rendered answer. To add a case, add its name and markdown (any
 * text) and run `bun run rendered-text-fixture`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markdownText } from "../src/lib/markdownText";

interface Case {
  name: string;
  markdown: string;
  text: string;
}

const file = path.resolve(import.meta.dirname, "../../../internal/store/thread/testdata/rendered_text.json");
const cases = JSON.parse(readFileSync(file, "utf8")) as Case[];
const out = cases.map((c) => ({ name: c.name, markdown: c.markdown, text: markdownText(c.markdown) }));
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`${String(out.length)} cases written to ${file}`);
