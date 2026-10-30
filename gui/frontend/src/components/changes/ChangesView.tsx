import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LogEntryView, WorktreeDetailView } from "@/api/worktreeDetail";
import { Age } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { Tip } from "@/components/ui/tooltip";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { diffOfChange, openDiffInPanel } from "@/stores/filePanel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { buildFileRows, fileTotals, shortRef, statusColor, type FileRow } from "./files";

const FILE_ROW_H = 24;
const LOG_ROW_H = 24;
/** The Changes and Commits lists show this many rows, then scroll inside the panel. */
const MAX_ROWS = 10;

/**
 * A changed file: status letter, directory (cut from the left), name, lines added and
 * deleted. A click (or Enter, Space) opens the file's Diff tab in the panel (ChangesBody's
 * items). The tooltip is the full path while the row cuts it short, and a rename's source always.
 */
function FileLine({ row }: { row: FileRow }) {
  return (
    <NavRow
      navKey={row.key}
      activateOnClick
      tip={row.oldPath ? `${row.oldPath} → ${row.path}` : row.path}
      // A rename's source is not on the row; a plain path only hides when it is cut short.
      tipWhenTruncated={!row.oldPath}
      className="grid h-full grid-cols-[1.25rem_minmax(0,1fr)_5ch_5ch] items-center gap-x-2 px-1.5 text-body-sm font-mono"
    >
      <span className={cn("text-center", statusColor[row.status] ?? "text-cf-text-muted")} data-status={row.status}>
        {row.status}
      </span>
      <span className="flex min-w-0 items-center" data-testid="file-path">
        {row.dir && <span className="min-w-0 truncate text-left text-cf-text-muted [direction:rtl]" data-testid="file-dir">{`‎${row.dir}‎`}</span>}
        <span className="max-w-full shrink-0 truncate" data-testid="file-name">
          {row.name}
        </span>
        {row.conflict && <span className="ml-1.5 shrink-0 text-caption-sm text-cf-error-text">conflict</span>}
      </span>
      <span className="text-right text-cf-diff-addition tabular-nums" data-testid="file-added">
        {row.added > 0 ? `+${String(row.added)}` : row.binary && row.deleted === 0 ? <span className="text-cf-text-muted">bin</span> : ""}
      </span>
      <span className="text-right text-cf-diff-deletion tabular-nums" data-testid="file-deleted">
        {row.deleted > 0 ? `−${String(row.deleted)}` : ""}
      </span>
    </NavRow>
  );
}

function LogLine({ e }: { e: LogEntryView }) {
  return (
    <NavRow
      navKey={`l:${e.sha}`}
      tip={`${e.sha}\n${e.authorName} <${e.authorEmail}>`}
      className="grid h-full grid-cols-[4.5rem_minmax(0,1fr)_3rem_minmax(6rem,10rem)] items-center gap-3 px-1.5 text-body-sm @max-[420px]:grid-cols-[4rem_minmax(0,1fr)_2.5rem] @max-[420px]:gap-2"
    >
      <span className="font-mono text-cf-warning-text/80">{e.shortSha}</span>
      <span className="truncate">{e.subject}</span>
      <Age ms={e.authoredAtMs} className="text-right" />
      <span className="truncate text-cf-text-muted @max-[420px]:hidden">{e.authorName}</span>
    </NavRow>
  );
}

/** Changes against the base: a flat list, conflicts first, ten rows then scrolling. */
function Changes({ detail, error, rows, base }: { detail: WorktreeDetailView | null; error: string; rows: FileRow[]; base: string }) {
  const totals = useMemo(() => fileTotals(detail?.files ?? []), [detail]);
  return (
    <section className="flex flex-col gap-1" data-testid="worktree-changes">
      <h3 className="flex min-w-0 items-baseline gap-2 text-subheading">
        <span>Changes</span>
        {detail && rows.length > 0 && (
          <span className="truncate text-caption tabular-nums" data-testid="changes-totals">
            {totals.count} {totals.count === 1 ? "file" : "files"}
            {totals.added > 0 && (
              <>
                {" · "}
                <span className="text-cf-diff-addition">+{totals.added}</span>
              </>
            )}
            {totals.deleted > 0 && (
              <>
                {totals.added > 0 ? " " : " · "}
                <span className="text-cf-diff-deletion">−{totals.deleted}</span>
              </>
            )}
          </span>
        )}
        {detail?.error && (
          <Tip label={detail.error}>
            <span className="shrink-0 text-caption text-cf-error-text">refresh failed</span>
          </Tip>
        )}
        {base && (
          <span className="ml-auto shrink-0 text-caption">
            vs <span className="text-code">{base}</span>
          </span>
        )}
      </h3>
      {!detail ? (
        <p className="text-caption">{error ? `Cannot compute: ${error}` : "Computing…"}</p>
      ) : rows.length === 0 ? (
        <p className="text-caption">No changes against {base || "HEAD"}.</p>
      ) : (
        <div className="-mx-1.5">
          <RowList rows={rows} rowKey={(r) => r.key} rowHeight={FILE_ROW_H} render={(r) => <FileLine row={r} />} capped maxHeight={MAX_ROWS * FILE_ROW_H} testId="changes-list" />
          {detail.filesTruncated && (
            <p className="mt-0.5 border-t px-1.5 pt-1 text-caption-sm" data-testid="changes-truncated">
              list truncated
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Commits ahead of the base: one row, collapsed; open, the log with the same ten-row cap. */
function Commits({ detail, base, open }: { detail: WorktreeDetailView; base: string; open: boolean }) {
  const newest = detail.log[0];
  return (
    <section className="flex flex-col gap-1" data-testid="worktree-commits" data-open={open}>
      <NavRow navKey="commits" activateOnClick className="-mx-1.5 flex h-7 min-w-0 items-center gap-1.5 px-1.5">
        <ChevronRight className={cn("size-3.5 shrink-0 text-cf-text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <span className="text-subheading">Commits</span>
        <span className="truncate text-caption tabular-nums">
          {detail.logTotal} ahead{base && ` of ${base}`}
        </span>
        {newest && (
          <span className="ml-auto shrink-0 text-caption">
            newest <Age ms={newest.authoredAtMs} />
          </span>
        )}
      </NavRow>
      {open && (
        <div className="-mx-1.5">
          <RowList rows={detail.log} rowKey={(e) => `l:${e.sha}`} rowHeight={LOG_ROW_H} render={(e) => <LogLine e={e} />} capped maxHeight={MAX_ROWS * LOG_ROW_H} testId="commits-list" />
        </div>
      )}
    </section>
  );
}

/**
 * The lists for one git worktree: its changes against the base, then its commits ahead
 * (collapsed). A file opens its Diff tab in this panel; a commit opens on GitHub.
 */
function ChangesBody({ projectId, path, slug, remotes }: { projectId: string; path: string; slug: string; remotes: readonly string[] }) {
  const detailEntry = useResource(worktreeDetailResource, detailKey(projectId, path));
  const detail: WorktreeDetailView | null = detailEntry?.data ?? null;
  const fileRows = useMemo(() => buildFileRows(detail?.files ?? []), [detail]);
  const base = detail?.baseRef ? shortRef(detail.baseRef, remotes) : "";
  const showCommits = detail !== null && detail.logTotal > 0;
  const [commitsOpen, setCommitsOpen] = useState(false);

  const items = useMemo<NavItem[]>(() => {
    const out: NavItem[] = [];
    // A changed file opens its Diff tab in this panel: the working tree when it has uncommitted changes, else the branch.
    for (const r of fileRows) out.push({ key: r.key, activate: () => void openDiffInPanel("current", diffOfChange(projectId, path, r)) });
    if (showCommits) {
      out.push({
        key: "commits",
        activate: () => {
          setCommitsOpen((o) => !o);
        },
        toggle: (open) => {
          if (open === commitsOpen) return false;
          setCommitsOpen(open);
          return true;
        },
      });
      if (commitsOpen) for (const e of detail.log) out.push({ key: `l:${e.sha}`, activate: slug ? () => void openUrl(`https://github.com/${slug}/commit/${e.sha}`) : undefined });
    }
    return out;
  }, [fileRows, showCommits, commitsOpen, detail, slug, projectId, path]);
  const nav = useNav(items);

  return (
    <NavProvider value={nav.ctx}>
      <div
        tabIndex={0}
        role="listbox"
        aria-label="Changes"
        aria-activedescendant={nav.activeDescendant}
        className="flex flex-col gap-3 outline-none"
        data-testid="changes-nav"
        onKeyDown={nav.onKeyDown}
      >
        <Changes detail={detail} error={detailEntry?.error ?? ""} rows={fileRows} base={base} />
        {showCommits && <Commits detail={detail} base={base} open={commitsOpen} />}
      </div>
    </NavProvider>
  );
}

/**
 * The side panel's Changes surface (surfaces/changes.ts): one worktree's changed files and
 * commits, nothing else (the thread info card shows its branch, sync state and pull
 * requests). It does not take focus when it mounts. Its own CSS container, so the commit
 * rows drop the author when narrow.
 */
export function ChangesView({ projectId, path }: { projectId: string; path: string }) {
  const known = useProjectsStore((s) => s.byId[projectId] !== undefined);
  const git = useProjectsStore((s) => s.byId[projectId]?.git !== false);
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const remotes = useProjectsStore((s) => s.byId[projectId]?.remotes);
  const exists = useProjectsStore((s) => findWorktree(s, projectId, path) !== undefined);
  return (
    <div className="@container min-w-0 px-4 py-3 @max-[340px]:px-3" data-testid="changes-surface" data-project={projectId} data-path={path}>
      {!known ? (
        <p className="text-body text-cf-text-muted">Project not found.</p>
      ) : !git ? (
        <p className="text-body text-cf-text-muted" data-testid="changes-nogit">
          Not a git repository: there are no changes to list.
        </p>
      ) : !exists ? (
        <p className="text-body text-cf-text-muted" data-testid="changes-missing">
          This worktree is gone (removed, or not made yet).
        </p>
      ) : (
        <ChangesBody key={path} projectId={projectId} path={path} slug={slug} remotes={remotes ?? []} />
      )}
    </div>
  );
}
