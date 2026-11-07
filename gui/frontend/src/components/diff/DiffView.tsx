import { useCallback, useEffect, useMemo, useState } from "react";
import { GitCompare, TriangleAlert } from "lucide-react";
import { compareWorktree, type CompareSource, type CompareTarget, type CompareView } from "@/api/compare";
import { FileEmptyState, FileLoading, NoticeBar } from "@/components/files/states";
import { REFRESH_DEBOUNCE_MS, useOnWindowVisible, useTabRead, useThrottled, useWorktreeChanges } from "@/components/files/useTabRead";
import { Button } from "@/components/ui/button";
import { useHeight, useWidth } from "@/lib/useWidth";
import { openDiffInPanel } from "@/stores/filePanel";
import { retitlePanelTab, setPanelTabParams } from "@/stores/panel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { diffTab, FROM_THREAD, sameSource, sourceParam, type DiffTarget } from "@/surfaces/diffTarget";
import { CompareBar } from "./CompareBar";
import { DiffFile } from "./DiffFile";
import { FileList } from "./FileList";
import { buildFileRows, diffTitle, inProject, listPace, pickRow, sourceLabel, type FileRow } from "./files";
import { ModelBand } from "./ModelBand";
import { useIndexChanges, useStatusChanges } from "./useStatusChanges";

/** Below this the panel cannot hold a rail beside a readable diff: the list goes on top. Its real width, not the window's. */
export const RAIL_MIN = 620;

const NO_REMOTES: readonly string[] = [];
const NO_PATHS: readonly string[] = [];

function Comparison({ tabId, tabTitle, target }: { tabId: string; tabTitle: string; target: DiffTarget }) {
  const { project, worktree, base, head } = target;
  const compare = useMemo<CompareTarget>(() => ({ projectId: project, worktree, base, head }), [project, worktree, base, head]);
  const paths = target.paths ?? NO_PATHS;
  const [pace, setPace] = useState(REFRESH_DEBOUNCE_MS);
  const read = useTabRead<CompareView>([project, worktree, sourceParam(base), sourceParam(head), ...paths].join("\u0000"), async (signal) => {
    const start = performance.now();
    const view = await compareWorktree(compare, paths, undefined, signal);
    setPace(listPace(performance.now() - start));
    return view;
  });
  const { reload } = read;
  const later = useThrottled(reload, pace, read.loading);
  useOnWindowVisible(later);
  useWorktreeChanges(project, worktree, later);
  useStatusChanges(project, worktree, later);
  useIndexChanges(base.kind === "staged" || head.kind === "staged" ? worktree : "", later);

  const [ref, width] = useWidth(RAIL_MIN);
  const height = useHeight(ref);
  const rail = width >= RAIL_MIN;
  const view = read.data;
  const rows = useMemo(() => buildFileRows(view?.files ?? []), [view]);
  const current = pickRow(rows, target.file, target.oldPath);
  const listed = current !== null && rows.includes(current);
  const remotes = useProjectsStore((s) => s.byId[project]?.remotes) ?? NO_REMOTES;
  const name = useProjectsStore((s) => s.byId[project]?.name ?? project);
  const branch = useProjectsStore((s) => findWorktree(s, project, worktree)?.branch ?? "");

  const place = { project: name, own: target.own };
  const compareName = view ? diffTitle(view, { branch, remotes, ...place }) : "";
  const named = target.heading ? inProject(target.heading, place) : !view ? tabTitle : target.thread ? `${FROM_THREAD} · ${compareName}` : compareName;
  useEffect(() => {
    if (named !== tabTitle) retitlePanelTab("current", tabId, named);
  }, [named, tabTitle, tabId]);

  const go = useCallback(
    (t: Partial<DiffTarget>) => {
      openDiffInPanel("current", { ...target, ...t }, named);
    },
    [target, named],
  );
  // What the tab keeps as it is used: nothing about that opens or activates it.
  const keep = useCallback(
    (t: Partial<DiffTarget>) => {
      setPanelTabParams("current", tabId, diffTab({ ...target, ...t }).params);
    },
    [target, tabId],
  );
  // The first file shown is the tab's from here on, or the next one to sort above it takes over.
  useEffect(() => {
    if (!target.file && current) keep({ file: current.path, oldPath: current.oldPath });
  }, [target.file, current, keep]);
  const pick = useCallback(
    (r: FileRow) => {
      go({ file: r.path, oldPath: r.oldPath });
    },
    [go],
  );
  const setSources = (b: CompareSource, h: CompareSource) => {
    // Swapped, a rename runs the other way: the same file, listed under its other name.
    const swapped = current?.oldPath && sameSource(b, head) && sameSource(h, base);
    go({ base: b, head: h, ...(swapped ? { file: current.oldPath, oldPath: current.path } : {}) });
  };

  // A side's name does not wait for, or fall with, the other side: only the merge base needs the answer.
  const [baseRef, setBaseRef] = useState("");
  if (view?.baseRef && view.baseRef !== baseRef) setBaseRef(view.baseRef);
  const mergeBase = baseRef || (read.error ? "merge base" : "…");
  const baseLabel = view?.base.label ?? sourceLabel(base, mergeBase);
  const headLabel = view?.head.label ?? sourceLabel(head, mergeBase);
  const compared = `${headLabel} and ${baseLabel} are the same here`;
  const refresh = (
    <Button variant="outline" size="sm" onClick={reload} data-testid="diff-refresh">
      Refresh
    </Button>
  );
  const hide = target.hide ?? [];
  const band = Boolean(target.heading) || Boolean(target.note) || hide.length > 0 || paths.length > 0;
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="diff-surface" data-project={project} data-path={worktree} data-loading={read.loading || undefined}>
      {band && (
        <ModelBand
          thread={target.thread ?? ""}
          heading={target.heading ?? ""}
          note={target.note ?? ""}
          paths={paths}
          hidden={hide.length > 0}
          onReveal={() => {
            go({ hide: [], paths: [] });
          }}
          onDismiss={() => {
            keep({ note: "" });
          }}
        />
      )}
      {!hide.includes("compare") && <CompareBar projectId={project} base={baseLabel} head={headLabel} baseSource={base} headSource={head} baseLabel={view?.baseRef || "HEAD"} wide={rail} onChange={setSources} />}
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
        <FileEmptyState icon={TriangleAlert} heading="Cannot compare" detail={view.error} testId="diff-source-missing">
          {refresh}
        </FileEmptyState>
      ) : !current && view.skippedNames === 0 ? (
        <FileEmptyState icon={GitCompare} heading="No changes" detail={`${compared}.`} testId="diff-empty">
          {refresh}
        </FileEmptyState>
      ) : (
        <div className={rail ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 flex-col"}>
          {!hide.includes("files") && (
            <FileList
              view={view}
              rows={rows}
              current={listed ? current : null}
              onPick={pick}
              rail={rail}
              height={height}
              query={target.filter ?? ""}
              onQuery={(filter) => {
                keep({ filter });
              }}
              fold={target.fold}
              onFold={(fold) => {
                keep({ fold });
              }}
            />
          )}
          {current ? (
            <DiffFile key={current.key} target={compare} row={current} listed={listed} compared={compared} onRefresh={reload} />
          ) : (
            <FileEmptyState icon={GitCompare} heading="Nothing to show" detail={view.skippedNames === 1 ? "The one file that differs has a name that is not UTF-8." : `The ${String(view.skippedNames)} files that differ have names that are not UTF-8.`} testId="diff-only-skipped" />
          )}
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
