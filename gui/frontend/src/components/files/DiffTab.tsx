import { useMemo } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, FileText, FileX, GitCompare, TriangleAlert } from "lucide-react";
import { getWorktreeFileDiff, type DiffScopeView, type FileDiffView } from "@/api/fileDiff";
import { CodeDiff, CodeScroll } from "@/components/code/CodeDiff";
import { shortRef } from "@/components/overview/facts";
import { statusColor } from "@/components/overview/files";
import { Button } from "@/components/ui/button";
import { dirPart, fileName } from "@/lib/filePath";
import { diffStats } from "@/lib/toolSummary";
import { cn } from "@/lib/utils";
import { setDiffStyle, useCodeViewStore, type DiffStyle } from "@/stores/codeView";
import { openDiffInPanel, openFileInPanel } from "@/stores/filePanel";
import { useProjectsStore } from "@/stores/projects";
import type { DiffTarget } from "@/surfaces/fileTarget";
import type { FilePlace } from "./fileActions";
import { FileActions, FileHeader, HeaderAction, HeaderMeta, ModeSwitch, WrapToggle } from "./FileHeader";
import { firstChangeLine } from "./fileKind";
import { FileEmptyState, FileLoading, NoticeBar } from "./states";
import { useDebounced, useOnWindowVisible, useTabRead, useToolEdits, useWorktreeChanges } from "./useTabRead";
import { VIRTUALIZE_LINES } from "./CodeBody";

const STYLES = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const satisfies readonly { value: DiffStyle; label: string }[];

const SCOPES = [
  { value: "working", label: "Working tree" },
  { value: "branch", label: "Branch" },
] as const satisfies readonly { value: DiffScopeView; label: string }[];

const NOTHING = { added: 0, removed: 0 };

/** The diff's parse (for counts, the first change and its length) and the sides CodeDiff takes. */
function useParsed(d: FileDiffView | null, name: string, oldName: string) {
  return useMemo(() => {
    if (!d || d.error || d.old.binary || d.new.binary || (!d.old.present && !d.new.present)) return null;
    const oldFile = d.old.present ? { name: oldName, contents: d.old.text } : null;
    // A deleted file's new side is empty: every line shows as removed.
    const newFile = { name, contents: d.new.present ? d.new.text : "" };
    const meta = parseDiffFromFile(oldFile, newFile);
    const lines = meta.hunks.reduce((n, h) => n + h.unifiedLineCount, 0);
    return { oldFile, newFile, stats: diffStats([meta]), first: firstChangeLine(meta), lines };
  }, [d, name, oldName]);
}

/**
 * The Diff tab (surfaces/diff.ts): one changed file of a worktree from
 * ProjectService.GetWorktreeFileDiff, both sides whole, so the library's hunk separators
 * expand into the rest of the file. Header A: Unified | Split (the codeView store, for
 * every diff), Working tree | Branch (the tab's scope: switching re-reads), the status
 * letter, the counts and the base. Read again like the File tab (useTabRead).
 */
export function DiffTab({ target }: { target: DiffTarget }) {
  const { project, worktree, path, oldPath, scope } = target;
  const read = useTabRead<FileDiffView>(`${project}\u0000${worktree}\u0000${path}\u0000${oldPath}\u0000${scope}`, (signal) =>
    getWorktreeFileDiff({ projectId: project, worktree, file: path, oldPath, scope }, undefined, signal),
  );
  const { reload } = read;
  const later = useDebounced(reload);
  const abs = `${worktree.replace(/\/+$/, "")}/${path}`;
  useOnWindowVisible(later);
  useWorktreeChanges(project, worktree, later);
  useToolEdits(abs, later);

  const d = read.data;
  const name = fileName(path) || path;
  const parsed = useParsed(d, path, oldPath || path);
  const remotes = useProjectsStore((s) => s.byId[project]?.remotes);
  const base = d?.baseRef ? shortRef(d.baseRef, remotes ?? []) : "HEAD";
  const style = useCodeViewStore((s) => s.diffStyle);
  const place = useMemo<FilePlace>(() => ({ project, dir: worktree, file: abs }), [project, worktree, abs]);
  const line = parsed?.first ?? undefined;
  const stats = parsed?.stats ?? NOTHING;
  const showsNew = d !== null && d.new.present;

  const openFile = showsNew ? (
    <HeaderAction
      icon={FileText}
      label="Open file"
      testId="diff-open-file"
      onClick={() => {
        openFileInPanel("current", { project, base: worktree, path, line });
      }}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-tab" data-path={path} data-scope={scope} data-style={style} data-loading={read.loading || undefined}>
      <FileHeader
        icon={FileDiff}
        name={name}
        dir={dirPart(path)}
        fullPath={oldPath ? `${abs}\nrenamed from ${oldPath}` : abs}
        actions={<FileActions place={place} line={line} onRefresh={reload} extra={openFile} />}
      >
        <ModeSwitch options={STYLES} value={style} onChange={setDiffStyle} label="Diff layout" testId="diff-style" />
        <ModeSwitch
          options={SCOPES}
          value={scope}
          onChange={(s) => {
            openDiffInPanel("current", { ...target, scope: s });
          }}
          label="Compare"
          testId="diff-scope"
        />
        {d && !d.error && (
          <HeaderMeta testId="diff-meta">
            {d.status && (
              <>
                <span className={cn("font-mono font-semibold", statusColor[d.status] ?? "text-cf-text-muted")} data-testid="diff-status">
                  {d.status}
                </span>
                {" · "}
              </>
            )}
            {stats.added > 0 && <span className="text-cf-diff-addition">+{stats.added} </span>}
            {stats.removed > 0 && <span className="text-cf-diff-deletion">−{stats.removed} </span>}
            {(stats.added > 0 || stats.removed > 0) && "· "}vs {base}
          </HeaderMeta>
        )}
        <span className="flex-1" />
        {parsed && <WrapToggle />}
      </FileHeader>
      {d && read.error && <NoticeBar testId="file-refresh-error">Refresh failed: {read.error}</NoticeBar>}
      {d && (d.old.truncated || d.new.truncated) && <NoticeBar testId="diff-truncated">Over 1 MiB: the diff covers the first MiB of each side</NoticeBar>}
      <DiffBody d={d} error={read.error} reload={reload} parsed={parsed} scope={scope} base={base} oldPath={oldPath} />
    </div>
  );
}

function DiffBody({
  d,
  error,
  reload,
  parsed,
  scope,
  base,
  oldPath,
}: {
  d: FileDiffView | null;
  error: string | null;
  reload: () => void;
  parsed: ReturnType<typeof useParsed>;
  scope: DiffScopeView;
  base: string;
  oldPath: string;
}) {
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
  if (d.status === "R" && parsed?.lines === 0) return <FileEmptyState icon={GitCompare} heading="Renamed" detail={`From ${oldPath}; the contents are the same.`} testId="diff-renamed" />;
  if (!parsed || !d.status || parsed.lines === 0)
    return (
      <FileEmptyState
        icon={GitCompare}
        heading="No changes"
        detail={scope === "branch" ? `Nothing committed on the branch changes this file against ${base}.` : `The file on disk matches ${base}.`}
        testId="diff-none"
      />
    );
  const diff = <CodeDiff oldFile={parsed.oldFile} newFile={parsed.newFile} />;
  return parsed.lines > VIRTUALIZE_LINES ? (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="diff-code" data-virtual="">
      <CodeScroll className="min-h-0 flex-1 overflow-auto">{diff}</CodeScroll>
    </div>
  ) : (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="diff-code">
      {diff}
    </div>
  );
}
