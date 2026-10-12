/**
 * Unified diffs for a rendered thread's Edit and Write rows (docs/notes/rendered-threads-2-gui.md):
 * from the tool result's structuredPatch when Claude sent one (real line numbers), else from
 * the Edit's old_string / new_string (a line diff without line numbers: where in the file
 * is unknown, e.g. while the Edit waits for permission), and a Write that
 * created a file as all additions. A removed line directly followed by an added one gets
 * the changed span of each marked (common prefix and suffix left out) for the word-level
 * highlight. Pure functions.
 */

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  /** Line number in the old file (ctx, del); null for an addition or when unknown. */
  oldNo: number | null;
  newNo: number | null;
  /** The changed span [start, end) of the text, paired with the line it replaces. */
  mark?: readonly [number, number];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** Where in the file is unknown: no line numbers, a bare "@@" header. */
  unnumbered?: boolean;
}

/** One hunk of Claude's structuredPatch (the `diff` package's format). */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** " ctx", "-del", "+add" ("\\ No newline at end of file" lines are skipped). */
  lines: readonly string[];
}

type Op = { kind: "ctx" | "add" | "del"; text: string };

/** Above this many cells (old x new lines) the diff is everything removed, then everything added. */
const MAX_CELLS = 4_000_000;

/** The edit script turning `a` into `b` (longest common subsequence of lines). */
export function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  // Common prefix and suffix first: most edits touch a few lines of a larger block.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const head: Op[] = a.slice(0, pre).map((text) => ({ kind: "ctx", text }));
  const tail: Op[] = a.slice(a.length - suf).map((text) => ({ kind: "ctx", text }));
  const x = a.slice(pre, a.length - suf);
  const y = b.slice(pre, b.length - suf);
  const n = x.length;
  const m = y.length;
  let mid: Op[];
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    mid = [...x.map((text): Op => ({ kind: "del", text })), ...y.map((text): Op => ({ kind: "add", text }))];
  } else {
    // lcs[i][j]: LCS length of x[i:] and y[j:], in one flat array.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
      }
    }
    mid = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        mid.push({ kind: "ctx", text: x[i] ?? "" });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        mid.push({ kind: "del", text: x[i++] ?? "" });
      } else {
        mid.push({ kind: "add", text: y[j++] ?? "" });
      }
    }
    while (i < n) mid.push({ kind: "del", text: x[i++] ?? "" });
    while (j < m) mid.push({ kind: "add", text: y[j++] ?? "" });
  }
  return [...head, ...mid, ...tail];
}

/** Splits text into lines; a trailing newline does not make an empty last line. */
export function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Numbers an edit script from (oldStart, newStart) and cuts it into hunks with `context` lines around changes. */
function toHunks(ops: readonly Op[], oldStart: number, newStart: number, context: number): DiffHunk[] {
  const numbered: DiffLine[] = [];
  let o = oldStart;
  let n = newStart;
  for (const op of ops) {
    if (op.kind === "ctx") numbered.push({ kind: "ctx", text: op.text, oldNo: o++, newNo: n++ });
    else if (op.kind === "del") numbered.push({ kind: "del", text: op.text, oldNo: o++, newNo: null });
    else numbered.push({ kind: "add", text: op.text, oldNo: null, newNo: n++ });
  }
  const changed = numbered.map((l, i) => (l.kind === "ctx" ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];
  const hunks: DiffHunk[] = [];
  let from = Math.max(0, (changed[0] ?? 0) - context);
  let to = Math.min(numbered.length, (changed[0] ?? 0) + context + 1);
  const push = () => {
    const lines = numbered.slice(from, to);
    hunks.push(hunkOf(lines, oldStart, newStart));
  };
  for (const c of changed.slice(1)) {
    if (c - context <= to) to = Math.min(numbered.length, c + context + 1);
    else {
      push();
      from = Math.max(0, c - context);
      to = Math.min(numbered.length, c + context + 1);
    }
  }
  push();
  return hunks.map(markWords);
}

function hunkOf(lines: DiffLine[], oldStart: number, newStart: number): DiffHunk {
  const firstOld = lines.find((l) => l.oldNo !== null)?.oldNo ?? oldStart;
  const firstNew = lines.find((l) => l.newNo !== null)?.newNo ?? newStart;
  return {
    oldStart: firstOld,
    oldLines: lines.filter((l) => l.kind !== "add").length,
    newStart: firstNew,
    newLines: lines.filter((l) => l.kind !== "del").length,
    lines,
  };
}

/**
 * An Edit's old_string → new_string as hunks, numbered from `startLine`; without one the
 * position in the file is unknown and the hunks carry no line numbers.
 */
export function editHunks(oldStr: string, newStr: string, opts: { context?: number; startLine?: number } = {}): DiffHunk[] {
  const hunks = toHunks(diffLines(splitLines(oldStr), splitLines(newStr)), opts.startLine ?? 1, opts.startLine ?? 1, opts.context ?? 3);
  if (opts.startLine !== undefined) return hunks;
  return hunks.map((h) => ({ ...h, unnumbered: true, lines: h.lines.map((l) => ({ ...l, oldNo: null, newNo: null })) }));
}

/** Claude's structuredPatch as hunks. */
export function patchHunks(patch: readonly StructuredPatchHunk[]): DiffHunk[] {
  return patch.map((h) => {
    const lines: DiffLine[] = [];
    let o = h.oldStart;
    let n = h.newStart;
    for (const raw of h.lines) {
      const sign = raw.charAt(0);
      const text = raw.slice(1);
      if (sign === "+") lines.push({ kind: "add", text, oldNo: null, newNo: n++ });
      else if (sign === "-") lines.push({ kind: "del", text, oldNo: o++, newNo: null });
      else if (sign === " ") lines.push({ kind: "ctx", text, oldNo: o++, newNo: n++ });
    }
    return markWords({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines });
  });
}

/** A new file's content as one all-added hunk. */
export function addedHunks(content: string): DiffHunk[] {
  const lines = splitLines(content);
  if (lines.length === 0) return [];
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((text, i) => ({ kind: "add", text, oldNo: null, newNo: i + 1 })) }];
}

/** The changed spans of a replaced line and its replacement: what is left after their common prefix and suffix. */
export function changedSpans(a: string, b: string): [[number, number], [number, number]] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [
    [pre, a.length - suf],
    [pre, b.length - suf],
  ];
}

/**
 * Marks word-level changes: in each run of removed lines followed by as many added lines,
 * line k of one pairs with line k of the other. Only when the pair shares something (a
 * prefix or suffix), else the whole line is the change and nothing is marked.
 */
export function markWords(h: DiffHunk): DiffHunk {
  const lines = h.lines.slice();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (lines[d]?.kind === "del") d++;
    let a = d;
    while (lines[a]?.kind === "add") a++;
    const dels = d - i;
    if (dels === a - d) {
      for (let k = 0; k < dels; k++) {
        const del = lines[i + k];
        const add = lines[d + k];
        if (!del || !add) continue;
        const [sd, sa] = changedSpans(del.text, add.text);
        const shares = sd[0] > 0 || sd[1] < del.text.length;
        if (!shares || (sd[0] === sd[1] && sa[0] === sa[1])) continue;
        lines[i + k] = { ...del, mark: sd };
        lines[d + k] = { ...add, mark: sa };
      }
    }
    i = a;
  }
  return { ...h, lines };
}

/** Added and removed line counts. */
export function diffStats(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }
  return { added, removed };
}

/** "@@ -18,9 +18,14 @@" ("@@" when unnumbered) */
export function hunkHeader(h: DiffHunk): string {
  if (h.unnumbered) return "@@";
  return `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`;
}
