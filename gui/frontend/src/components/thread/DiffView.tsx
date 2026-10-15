import { memo, useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { hunkHeader, type DiffHunk, type DiffLine } from "@/lib/diff";
import { grammarForPath, highlightLines, markTokens, type Token } from "@/lib/highlight";
import { splitPath } from "@/lib/toolSummary";
import { TokenSpans } from "./Code";

/** Lines shown before "Show N more lines". */
const DIFF_LIMIT = 400;

/**
 * Each line's tokens, highlighted per side (the old side's context and removed lines, the
 * new side's context and added lines), so a construct spanning lines keeps its colour.
 */
function highlightHunk(h: DiffHunk, grammar: string): Token[][] {
  const side = (keep: (l: DiffLine) => boolean) => {
    const idx = h.lines.flatMap((l, i) => (keep(l) ? [i] : []));
    const toks = highlightLines(idx.map((i) => h.lines[i]?.text ?? "").join("\n"), grammar);
    return new Map(idx.map((i, k) => [i, toks[k] ?? []]));
  };
  const old = side((l) => l.kind !== "add");
  const neu = side((l) => l.kind !== "del");
  return h.lines.map((l, i) => (l.kind === "del" ? old.get(i) : neu.get(i)) ?? []);
}

function unified(hunks: readonly DiffHunk[]): string {
  return hunks.map((h) => [hunkHeader(h), ...h.lines.map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)].join("\n")).join("\n");
}

/** An inline unified diff: file header, hunk headers, old/new line numbers, +/− gutter, word marks. */
export const DiffView = memo(function DiffView({ path, hunks, cwd }: { path: string; hunks: readonly DiffHunk[]; cwd: string }) {
  const grammar = grammarForPath(path);
  const tokens = useMemo(() => hunks.map((h) => highlightHunk(h, grammar)), [hunks, grammar]);
  const total = hunks.reduce((n, h) => n + h.lines.length, 0);
  const [all, setAll] = useState(false);
  const { base, dir } = splitPath(path, cwd);
  let left = all ? Infinity : DIFF_LIMIT;
  return (
    <div className="diff selectable" data-testid="thread-diff">
      <div className="dh">
        <Tip label={path} align="start">
          <span className="path">
            {dir && <span className="dir">{dir}/</span>}
            {base}
          </span>
        </Tip>
        <span className="flex-1" />
        <Tip label="Copy diff">
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Copy diff"
            onClick={() => void copyText(unified(hunks))}
          >
            <Copy className="size-3" />
          </button>
        </Tip>
      </div>
      {hunks.map((h, hi) => {
        if (left <= 0) return null;
        const lines = h.lines.slice(0, left);
        left -= lines.length;
        return (
          <div key={hi}>
            <div className="hunk">{hunkHeader(h)}</div>
            {lines.map((l, i) => {
              const toks = markTokens(tokens[hi]?.[i] ?? [], l.mark);
              return (
                <div key={i} className={l.kind === "add" ? "l la" : l.kind === "del" ? "l lr" : "l"} data-kind={l.kind}>
                  <span className="o">{l.oldNo ?? ""}</span>
                  <span className="n">{l.newNo ?? ""}</span>
                  <span className="g">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                  <span>
                    <TokenSpans tokens={toks} mark={l.kind === "add" ? "ins" : l.kind === "del" ? "del" : undefined} />
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {!all && total > DIFF_LIMIT && (
        <button
          type="button"
          className="more w-full text-left hover:text-foreground"
          onClick={() => {
            setAll(true);
          }}
        >
          Show {total - DIFF_LIMIT} more lines
        </button>
      )}
    </div>
  );
});
