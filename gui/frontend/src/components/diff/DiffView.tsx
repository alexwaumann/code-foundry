import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";
import { GitCompare, TriangleAlert } from "lucide-react";
import { compareWorktree, type CompareSource, type CompareTarget, type CompareView } from "@/api/compare";
import { FileEmptyState, FileLoading, NoticeBar } from "@/components/files/states";
import { useDebounced, useOnWindowVisible, useTabRead, useWorktreeChanges } from "@/components/files/useTabRead";
import { Button } from "@/components/ui/button";
import { useWidth } from "@/lib/useWidth";
import { openDiffInPanel } from "@/stores/filePanel";
import { retitlePanelTab } from "@/stores/panel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { sourceParam, type DiffTarget } from "@/surfaces/diffTarget";
import { CompareBar } from "./CompareBar";
import { DiffFile } from "./DiffFile";
import { FileList } from "./FileList";
import { buildFileRows, diffTitle, pickRow, type FileRow } from "./files";

/** Below this the panel cannot hold a rail beside a readable diff: the list goes on top. Its real width, not the window's. */
export const RAIL_MIN = 620;

/**
 * What git's status says of a checkout: staged, modified, untracked and HEAD. A staged change
 * can leave the detail the same (useWorktreeChanges sees nothing), and a comparison of the
 * index still has to follow it.
 */
function useStatusChanges(projectId: string, worktree: string, onChange: () => void): void {
  const stamp = useProjectsStore((s) => {
    const wt = findWorktree(s, projectId, worktree);
    return wt ? `${wt.head}|${String(wt.status.staged)}|${String(wt.status.modified)}|${String(wt.status.untracked)}` : "";
  });
  const seen = useRef(stamp);
  const fire = useEffectEvent(onChange);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    fire();
  }, [stamp]);
}

const NO_REMOTES: readonly string[] = [];

function Comparison({ tabId, tabTitle, target }: { tabId: string; tabTitle: string; target: DiffTarget }) {
  const { project, worktree, base, head } = target;
  const compare = useMemo<CompareTarget>(() => ({ projectId: project, worktree, base, head }), [project, worktree, base, head]);
  const read = useTabRead<CompareView>([project, worktree, sourceParam(base), sourceParam(head)].join("\u0000"), (signal) => compareWorktree(compare, [], undefined, signal));
  const { reload } = read;
  const later = useDebounced(reload);
  useOnWindowVisible(later);
  useWorktreeChanges(project, worktree, later);
  useStatusChanges(project, worktree, later);

  const [ref, width] = useWidth(RAIL_MIN);
  const rail = width >= RAIL_MIN;
  const view = read.data;
  const rows = useMemo(() => buildFileRows(view?.files ?? []), [view]);
  const current = pickRow(rows, target.file);
  const remotes = useProjectsStore((s) => s.byId[project]?.remotes) ?? NO_REMOTES;
  const name = useProjectsStore((s) => s.byId[project]?.name ?? project);
  const branch = useProjectsStore((s) => findWorktree(s, project, worktree)?.branch ?? "");

  const named = view ? diffTitle(view, { branch, remotes, project: name, own: target.own }) : tabTitle;
  useEffect(() => {
    if (named !== tabTitle) retitlePanelTab("current", tabId, named);
  }, [named, tabTitle, tabId]);

  const go = useCallback(
    (t: Partial<DiffTarget>) => {
      openDiffInPanel("current", { ...target, ...t }, named);
    },
    [target, named],
  );
  const pick = useCallback(
    (r: FileRow) => {
      go({ file: r.path, oldPath: r.oldPath });
    },
    [go],
  );
  const setSources = (b: CompareSource, h: CompareSource) => {
    go({ base: b, head: h });
  };

  const baseLabel = view?.base.label ?? "…";
  const headLabel = view?.head.label ?? "…";
  const compared = `${headLabel} and ${baseLabel} are the same here`;
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="diff-surface" data-project={project} data-path={worktree} data-loading={read.loading || undefined}>
      <CompareBar projectId={project} base={baseLabel} head={headLabel} baseSource={base} headSource={head} baseLabel={view?.baseRef || "HEAD"} wide={rail} onChange={setSources} />
      {view && read.error && <NoticeBar testId="diff-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {!view && read.error ? (
        <FileEmptyState icon={TriangleAlert} heading="Cannot compare" detail={read.error} testId="diff-compare-failed">
          <Button variant="outline" size="sm" onClick={reload} data-testid="diff-retry">
            Retry
          </Button>
        </FileEmptyState>
      ) : !view ? (
        <FileLoading />
      ) : view.error ? (
        <FileEmptyState icon={TriangleAlert} heading="Cannot compare" detail={view.error} testId="diff-source-missing" />
      ) : rows.length === 0 ? (
        <FileEmptyState icon={GitCompare} heading="No changes" detail={`${compared}.`} testId="diff-empty" />
      ) : (
        <div className={rail ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 flex-col"}>
          <FileList view={view} rows={rows} current={current} onPick={pick} rail={rail} />
          {current && <DiffFile key={current.key} target={compare} row={current} compared={compared} />}
        </div>
      )}
    </div>
  );
}

/**
 * The side panel's Diff surface (surfaces/diff.ts): two sources of one checkout, compared
 * file by file. The list comes from ProjectService.CompareWorktree and only the file on
 * screen is read. It is a rail beside the diff when the panel is wide and a list above it
 * when narrow. It does not take focus when it mounts. docs/notes/diff-viewer-2.md.
 */
export function DiffView({ tabId, tabTitle, target }: { tabId: string; tabTitle: string; target: DiffTarget }) {
  const { project, worktree } = target;
  const known = useProjectsStore((s) => s.byId[project] !== undefined);
  const git = useProjectsStore((s) => s.byId[project]?.git !== false);
  const exists = useProjectsStore((s) => findWorktree(s, project, worktree) !== undefined);
  if (!known) return <FileEmptyState icon={TriangleAlert} heading="Project not found" testId="diff-no-project" />;
  if (!git) return <FileEmptyState icon={GitCompare} heading="Not a git repository" detail="There are no changes to list." testId="diff-nogit" />;
  if (!exists) return <FileEmptyState icon={GitCompare} heading="This worktree is gone" detail="Removed, or not made yet." testId="diff-missing" />;
  return <Comparison key={worktree} tabId={tabId} tabTitle={tabTitle} target={target} />;
}
