import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import { CodeBody } from "@/components/files/CodeBody";
import { previewKindOf } from "@/components/files/previews/registry";
import { observeShadow } from "@/components/files/useFileFind";
import { matchPosition, type MatchRow } from "@/lib/textSearch";
import { textRuns } from "@/lib/threadSearch";
import { clearTextPreviewPaint, paintTextPreview, previewView, revealMatch } from "./previewPaint";
import type { PreviewRead } from "./useTextSearch";
import "@/components/search/search.css";

/** The crumb: the file's name, its directory (cut from the left), its project in a thread with several, and where the match is in the file. */
function Crumb({ row, project }: { row: MatchRow; project: string | null }) {
  const slash = row.file.path.lastIndexOf("/");
  const name = row.file.path.slice(slash + 1);
  const dir = slash > 0 ? row.file.path.slice(0, slash) : "";
  return (
    <div className="flex shrink-0 items-baseline gap-2 border-b px-4 py-2.5" data-testid="text-preview-crumb">
      <span className="max-w-[45%] shrink-0 truncate text-body-sm font-medium text-cf-text">{name}</span>
      <span className="min-w-0 flex-1 truncate text-left text-caption text-cf-text-muted [direction:rtl]">{dir ? `‎${dir}‎` : ""}</span>
      {project !== null && <span className="max-w-[25%] shrink-0 truncate text-caption text-cf-text-muted">{project}</span>}
      <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="text-preview-position">
        {matchPosition(row)}
      </span>
    </div>
  );
}

/** The row's own line, standing in for a file the preview cannot show around it, and why. */
function LineOnly({ row, note }: { row: MatchRow; note: string }) {
  const runs = useMemo(() => textRuns(row.line.text, row.line.ranges), [row.line]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3" data-testid="text-preview-line">
      <div className="flex gap-3.5 rounded-md bg-cf-control-hover px-2 py-1 text-code whitespace-pre">
        <span className="shrink-0 text-cf-text-muted tabular-nums">{row.line.line}</span>
        <span className="min-w-0 text-cf-text">
          {row.line.cutStart && <span className="text-cf-text-muted">…</span>}
          {runs.map((r, i) =>
            r.hit ? (
              <mark key={i} className="search-hit">
                {r.text}
              </mark>
            ) : (
              <span key={i}>{r.text}</span>
            ),
          )}
          {row.line.cutEnd && <span className="text-cf-text-muted">…</span>}
        </span>
      </div>
      <p className="text-caption text-cf-text-muted" data-testid="text-preview-note">
        {note}
      </p>
    </div>
  );
}

/**
 * The file as code (the File tab's CodeBody: its highlighting, line numbers, the line marked
 * and centred), every match of the query painted and the selected one solid
 * (previewPaint.ts), repainted as the library renders more lines.
 */
function CodePreview({ row, abs, text, lines, re }: { row: MatchRow; abs: string; text: string; lines: number; re: RegExp | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const lang = useMemo(() => previewKindOf(abs, null)?.source?.lang, [abs]);
  const match = row.line;
  const revealed = useRef("");
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const run = () => {
      frame = 0;
      const cur = paintTextPreview(root, re, match);
      // Sideways once per match, after CodeBody has brought its line into view.
      const id = `${abs}:${String(match.line)}`;
      if (cur && revealed.current !== id) {
        revealed.current = id;
        revealMatch(root, cur);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(run);
    };
    run();
    const stop = observeShadow(root, () => root.querySelector(DIFFS_TAG_NAME)?.shadowRoot ?? null, schedule);
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [abs, re, match]);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col" data-testid="text-preview-code" data-line={match.line}>
      <CodeBody key={abs} name={abs} text={text} lang={lang} lines={lines} line={match.line} lineAt={0.5} />
    </div>
  );
}

/**
 * The right side of the Text mode: the crumb, then the selected match's file around its line
 * as the File tab draws it, or the match's own line with a note when the file cannot show it
 * (previewPaint.ts previewView). Nothing under the crumb until the file's read is there.
 */
export function TextPreview({ row, read, re, project }: { row: MatchRow; read: PreviewRead | null; re: RegExp | null; project: string | null }) {
  useLayoutEffect(() => clearTextPreviewPaint, []);
  const view = useMemo(() => (read ? previewView(read, row.line) : null), [read, row.line]);
  useEffect(() => {
    if (view?.kind !== "code") clearTextPreviewPaint();
  }, [view]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="text-preview" data-path={row.file.path}>
      <Crumb row={row} project={project} />
      {view === null ? (
        <div className="min-h-0 flex-1" data-testid="text-preview-loading" />
      ) : view.kind === "code" ? (
        <CodePreview row={row} abs={row.fileKey} text={view.text} lines={view.lines} re={re} />
      ) : (
        <LineOnly row={row} note={view.note} />
      )}
    </div>
  );
}
