/**
 * A streaming answer's markdown cut into top-level blocks, so the finished ones can render
 * once each and only the growing last one re-parses per delta (components/thread/Code
 * StreamingMarkdown). Re-parsing the whole answer every frame made a long answer's stream
 * quadratic (76 KB: ~280 ms a frame).
 *
 * A cut goes at a blank line outside a fenced code block, and only once the next line has
 * begun and starts a new top-level block: not indented (a list item's continuation, an
 * indented code block) and not the next item of a list (a loose list stays one list). Each cut is
 * stable as the text grows. The blocks join back to the text (blank lines stay at the end
 * of the block before the cut), so a block parses as it would in the whole document but for
 * link reference definitions and footnotes, which resolve once the answer is rendered whole
 * when it ends.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/** Where each block after the first starts (offsets into text). */
export function blockStarts(text: string): number[] {
  const starts: number[] = [];
  let fence = ""; // the open fence's marker ("```", "~~~~"), "" outside one
  let blank = false; // the previous line was blank (outside a fence)
  let seen = false; // a non-blank line came before
  let list = false; // the current block is a list (a list item after a blank line continues it)
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end);
    const m = FENCE.exec(line);
    if (fence) {
      // A closing fence: the same character, at least as long, nothing after it but spaces.
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = "";
    } else if (line.trim() === "") {
      blank = true;
    } else {
      const item = LIST_ITEM.test(line);
      if (blank && seen && !/^\s/.test(line) && !(item && list)) {
        starts.push(pos);
        list = false;
      }
      if (item) list = true;
      blank = false;
      seen = true;
      if (m?.[1]) fence = m[1];
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return starts;
}

/** text split at blockStarts: the blocks concatenate back to text. */
export function markdownBlocks(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const at of blockStarts(text)) {
    out.push(text.slice(from, at));
    from = at;
  }
  out.push(text.slice(from));
  return out;
}
