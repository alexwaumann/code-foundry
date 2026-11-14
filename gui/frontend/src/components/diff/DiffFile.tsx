import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, FileText, FileX, GitCompare, TriangleAlert } from "lucide-react";
import { getCompareFile, type CompareFileSidesView, type CompareTarget } from "@/api/compare";
import { CodeDiff, CodeScroll } from "@/components/code/CodeDiff";
import { VIRTUALIZE_LINES } from "@/components/files/CodeBody";
import type { FilePlace } from "@/components/files/fileActions";
import { FileActions, FileHeader, HeaderAction, WrapToggle } from "@/components/files/FileHeader";
import { firstChangeLine } from "@/components/files/fileKind";
import { useKeepTopLine } from "@/components/files/useKeepTopLine";
import { FileEmptyState, FileLoading, NoticeBar } from "@/components/files/states";
import { useFileChanges, useOnWindowVisible, useTabRead, useThrottled, useWorktreeChanges } from "@/components/files/useTabRead";
import { Button } from "@/components/ui/button";
import { openFileInPanel } from "@/stores/filePanel";
import { useCodeViewStore } from "@/stores/codeView";
import { sourceParam } from "@/surfaces/diffTarget";
import { sameSides, type FileRow } from "./files";
import { useIndexChanges, useStatusChanges } from "./useStatusChanges";

/** The sides' parse (for the first change and its length) and what CodeDiff takes. */
function useParsed(d: CompareFileSidesView | null, name: string, oldName: string) {
  return useMemo(() => {
    if (!d || d.error || d.old.binary || d.new.binary || (!d.old.present && !d.new.present)) return null;
    const oldFile = d.old.present ? { name: oldName, contents: d.old.text } : null;
    // A deleted file's new side is empty: every line shows as removed.
    const newFile = { name, contents: d.new.present ? d.new.text : "" };
    const meta = parseDiffFromFile(oldFile, newFile);
    const lines = meta.hunks.reduce((n, h) => n + h.unifiedLineCount, 0);
    return { oldFile, newFile, first: firstChangeLine(meta), lines };
  }, [d, name, oldName]);
}

function Body({ d, error, reload, parsed, row, listed, compared }: { d: CompareFileSidesView | null; error: string | null; reload: () => void; parsed: ReturnType<typeof useParsed>; row: FileRow; listed: boolean; compared: string }) {
  if (!d && error)
    return (
      <FileEmptyState icon={TriangleAlert} heading="Cannot read the diff" detail={error} testId="diff-error">
        <Button variant="outline" size="sm" onClick={reload} data-testid="file-retry">
          Retry
        </Button>
      </FileEmptyState>
    );
  if (!d) return <FileLoading />;
  if (d.error) return <FileEmptyState icon={TriangleAlert} heading="Cannot compare" detail={d.error} testId="diff-unavailable" />;
  if (d.old.binary || d.new.binary) return <FileEmptyState icon={FileX} heading="Binary file" detail={d.status === "A" ? "Added" : d.status === "D" ? "Deleted" : "Changed"} testId="diff-binary" />;
  if (d.status === "R" && parsed?.lines === 0) return <FileEmptyState icon={GitCompare} heading="Renamed" detail={`From ${row.oldPath}; the contents are the same.`} testId="diff-renamed" />;
  if ((!parsed || !d.status || parsed.lines === 0) && !listed) return <FileEmptyState icon={GitCompare} heading="No changes" detail={`${row.path} is no longer in this comparison.`} testId="diff-unlisted" />;
  if (!parsed || !d.status || parsed.lines === 0) return <FileEmptyState icon={GitCompare} heading="No changes in the contents" detail={`${compared}.`} testId="diff-none" />;
  return <DiffCode parsed={parsed} />;
}

/**
 * The two sides' code, in its scroller. Its top row stays across a change of its width (a zoom, a
 * resize of the pane), as the File tab's top line does (components/files/useKeepTopLine.ts).
 */
function DiffCode({ parsed }: { parsed: NonNullable<ReturnType<typeof useParsed>> }) {
  const box = useRef<HTMLDivElement>(null);
  const virtual = parsed.lines > VIRTUALIZE_LINES;
  useKeepTopLine(box, virtual, "index");
  const diff = <CodeDiff oldFile={parsed.oldFile} newFile={parsed.newFile} />;
  return virtual ? (
    <div ref={box} className="flex min-h-0 flex-1 flex-col" data-testid="diff-code" data-virtual="">
      <CodeScroll className="min-h-0 flex-1 overflow-auto">{diff}</CodeScroll>
    </div>
  ) : (
    <div ref={box} className="min-h-0 flex-1 overflow-auto" data-testid="diff-code">
      {diff}
    </div>
  );
}

/**
 * One file of the comparison: its two sides, read when it is shown and not before
 * (ProjectService.GetWorktreeCompareFile), whole, so the library's hunk separators expand
 * into the rest of the file. Read again like the File tab (useTabRead), when git's status moves
 * (the index, which the detail does not follow), when the list's row for it changes, so the code
 * never says less than the row, and when what a side reads from is written: this file on disk,
 * the index. A save that keeps the counts changes nothing else. Refresh reads the list too. `listed` false: the file left
 * the comparison, and it stays on screen saying so, read like any other in case it comes back.
 * `live` false: nothing moves it but Refresh, for one commit, which does not change.
 */
export function DiffFile({ target, row, listed, compared, onRefresh, live = true }: { target: CompareTarget; row: FileRow; listed: boolean; compared: string; onRefresh: () => void; live?: boolean }) {
  const { projectId, worktree, base, head } = target;
  const key = [projectId, worktree, sourceParam(base), sourceParam(head), row.path, row.oldPath].join("\u0000");
  // A read that answers what the last one did keeps its answer, so nothing is parsed or drawn
  // again: a lockfile's parse and render block the window for seconds, on every unrelated save.
  const last = useRef<CompareFileSidesView | null>(null);
  const read = useTabRead<CompareFileSidesView>(key, async (signal) => {
    const next = await getCompareFile(target, row.path, row.oldPath, undefined, signal);
    if (last.current && sameSides(last.current, next)) return last.current;
    last.current = next;
    return next;
  });
  const { reload } = read;
  const throttled = useThrottled(reload, undefined, read.loading);
  const later = useCallback(() => {
    if (live) throttled();
  }, [live, throttled]);
  const abs = `${worktree.replace(/\/+$/, "")}/${row.path}`;
  useOnWindowVisible(later);
  useWorktreeChanges(projectId, worktree, later);
  useStatusChanges(projectId, worktree, later);
  useFileChanges(base.kind === "working" || head.kind === "working" ? abs : "", later);
  useIndexChanges(base.kind === "staged" || head.kind === "staged" ? worktree : "", later);
  const stamp = `${row.status}|${String(row.added)}|${String(row.deleted)}`;
  const seen = useRef(stamp);
  const again = useEffectEvent(later);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    again();
  }, [stamp]);

  const d = read.data;
  const parsed = useParsed(d, row.path, row.oldPath || row.path);
  const style = useCodeViewStore((s) => s.diffStyle);
  const place = useMemo<FilePlace>(() => ({ project: projectId, dir: worktree, file: abs }), [projectId, worktree, abs]);
  const line = parsed?.first ?? undefined;
  const actions = (
    <>
      {parsed && <WrapToggle />}
      <FileActions
        place={place}
        line={line}
        onRefresh={() => {
          reload();
          onRefresh();
        }}
        extra={
          d?.new.present && !d.new.submodule ? (
            <HeaderAction
              icon={FileText}
              label="Open file"
              testId="diff-open-file"
              onClick={() => {
                openFileInPanel("current", { project: projectId, base: worktree, path: row.path, line });
              }}
            />
          ) : null
        }
      />
    </>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="diff-file" data-path={row.path} data-style={style} data-loading={read.loading || undefined}>
      <FileHeader icon={FileDiff} name={row.name} dir={row.dir} fullPath={row.oldPath ? `${abs}\nrenamed from ${row.oldPath}` : abs} actions={actions} />
      {d && read.error && <NoticeBar testId="file-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {d && (d.old.truncated || d.new.truncated) && <NoticeBar testId="diff-truncated">Over 1 MiB: the diff covers the first MiB of each side</NoticeBar>}
      {d && !listed && parsed && parsed.lines > 0 && <NoticeBar testId="diff-unlisted-notice">Not in this comparison's file list</NoticeBar>}
      <Body d={d} error={read.error} reload={reload} parsed={parsed} row={row} listed={listed} compared={compared} />
    </div>
  );
}
