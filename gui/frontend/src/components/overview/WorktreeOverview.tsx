import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleX, Folder, GitBranch, GitBranchPlus, CloudUpload } from "lucide-react";
import type { CheckRunView, PullRequestView, RepoActivityView } from "@/api/gh";
import { isRemoteless, type GitStatusView, type RepoView, type WorktreeView } from "@/api/repo";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Button } from "@/components/ui/button";
import type { LogEntryView, WorktreeDetailView } from "@/api/worktreeDetail";
import { checksSummary } from "@/components/prs/format";
import { Age, ChecksBadge, Freshness, PrStateIcon, ReviewBadge } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { branchKey, branchPullRequestsResource, openUrl, repoActivityResource, useFreshness } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { openPublishDialog } from "@/stores/publish";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useResource } from "@/stores/resource";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { buildFileRows, describeChanges, fileTotals, type FileRow } from "./files";

const FILE_ROW_H = 24;
const LOG_ROW_H = 24;

function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  if (ahead === 0 && behind === 0) return <span className="text-emerald-400">✓ in sync</span>;
  return (
    <span className="tabular-nums">
      {ahead > 0 && <span className="text-emerald-400">↑{ahead}</span>}
      {ahead > 0 && behind > 0 && " "}
      {behind > 0 && <span className="text-amber-300">↓{behind}</span>}
    </span>
  );
}

/** Upstream and base comparison, plus the working tree summary. */
function SyncLine({ st }: { st: GitStatusView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs" data-testid="sync-line">
      <span>
        <span className="text-muted-foreground">{st.upstream ? `Upstream ${st.upstream}: ` : "Upstream: "}</span>
        {st.upstream ? <AheadBehind ahead={st.ahead} behind={st.behind} /> : <span className="text-muted-foreground">none</span>}
      </span>
      {st.baseRef && (
        <span>
          <span className="text-muted-foreground">Base {st.baseRef}: </span>
          <AheadBehind ahead={st.baseAhead ?? 0} behind={st.baseBehind ?? 0} />
        </span>
      )}
      <span>
        <span className="text-muted-foreground">Working tree: </span>
        <span className={st.dirty ? "text-amber-300" : "text-muted-foreground"}>{describeChanges(st)}</span>
      </span>
      {st.error && <span className="text-red-400" title={st.error}>status failed</span>}
    </div>
  );
}

function Section({ title, extra, children, testId }: { title: ReactNode; extra?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId}>
      <h2 className="mb-1.5 flex flex-wrap items-baseline gap-x-3 border-b pb-1 text-sm font-semibold">
        <span>{title}</span>
        {extra && <span className="ml-auto text-xs font-normal text-muted-foreground">{extra}</span>}
      </h2>
      {children}
    </section>
  );
}

const statusColor: Record<string, string> = {
  A: "text-emerald-400",
  M: "text-amber-300",
  D: "text-red-400",
  R: "text-sky-400",
  C: "text-sky-400",
  T: "text-sky-400",
  U: "text-red-400",
  "?": "text-muted-foreground",
};

function Counts({ added, deleted, binary }: { added: number; deleted: number; binary: boolean }) {
  if (binary && added === 0 && deleted === 0) return <span className="text-xs text-muted-foreground">bin</span>;
  return (
    <span className="text-xs tabular-nums">
      <span className="text-emerald-400">+{added}</span> <span className="text-red-400">−{deleted}</span>
    </span>
  );
}

function FileLine({ row }: { row: FileRow }) {
  return (
    <NavRow navKey={row.key} title={row.file?.oldPath ? `${row.file.oldPath} → ${row.path}` : row.path} className="flex h-full items-center gap-2 px-2 font-mono text-xs">
      <span className={cn("w-7 shrink-0 text-center", row.kind === "file" ? statusColor[row.status] : "text-muted-foreground")} data-status={row.status}>
        {row.kind === "file" ? row.status : ""}
      </span>
      <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: row.depth * 14 }}>
        {row.kind === "dir" &&
          (row.expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />)}
        <span className={cn("truncate", row.kind === "dir" && "text-sky-300")}>
          {row.name}
          {row.kind === "dir" && "/"}
        </span>
        {row.kind === "dir" && <span className="shrink-0 text-muted-foreground">({row.count})</span>}
        {row.file?.oldPath && <span className="truncate text-muted-foreground">← {row.file.oldPath}</span>}
        {row.uncommitted && row.kind === "file" && <span className="shrink-0 text-[10px] text-muted-foreground uppercase">wt</span>}
      </span>
      <span className="ml-auto shrink-0">{!row.file?.isDir && <Counts added={row.added} deleted={row.deleted} binary={row.binary} />}</span>
    </NavRow>
  );
}

function LogLine({ e }: { e: LogEntryView }) {
  return (
    <NavRow
      navKey={`l:${e.sha}`}
      title={`${e.sha}\n${e.authorName} <${e.authorEmail}>`}
      className="grid h-full grid-cols-[4.5rem_minmax(0,1fr)_3rem_minmax(6rem,10rem)] items-center gap-3 px-2 text-xs @max-[420px]:grid-cols-[4rem_minmax(0,1fr)_2.5rem] @max-[420px]:gap-2"
    >
      <span className="font-mono text-amber-200/80">{e.shortSha}</span>
      <span className="truncate">{e.subject}</span>
      <Age ms={e.authoredAtMs} className="text-right" />
      <span className="truncate text-muted-foreground @max-[420px]:hidden">{e.authorName}</span>
    </NavRow>
  );
}

function CheckLine({ c }: { c: CheckRunView }) {
  return (
    <NavRow navKey={`c:${c.url || c.name}`} title={c.url} className="flex h-6 items-center gap-2 px-2 pl-6 font-mono text-xs @max-[420px]:pl-2">
      {c.workflow && <span className="min-w-0 shrink truncate text-muted-foreground">{c.workflow}:</span>}
      <span className="min-w-0 truncate text-red-400">{c.name}</span>
      <span className="shrink-0 text-muted-foreground @max-[420px]:hidden">{c.conclusion.replace(/_/g, " ")}</span>
    </NavRow>
  );
}

function PrLine({ pr, prefix, viewer }: { pr: PullRequestView; prefix: string; viewer?: string }) {
  const by = viewer && pr.author.toLowerCase() === viewer.toLowerCase() ? "you" : pr.author;
  return (
    <NavRow
      navKey={`${prefix}:${String(pr.number)}`}
      title={`${pr.url}\nClick or Enter: open in the side panel · ⌘-click or ⌘↵: open on GitHub`}
      activateOnClick
      onCmdClick={() => void openUrl(pr.url)}
      className="flex h-6 items-center gap-2 px-2 pl-6 text-xs @max-[420px]:pl-2"
    >
      <PrStateIcon state={pr.state} draft={pr.draft} />
      <span className="text-muted-foreground tabular-nums">#{pr.number}</span>
      <span className="text-muted-foreground capitalize @max-[420px]:hidden">{pr.state}</span>
      {by && <span className="text-muted-foreground @max-[420px]:hidden">@{by}</span>}
      <span className="shrink-0 font-mono text-muted-foreground @max-[420px]:hidden">
        {pr.headRef} → {pr.baseRef}
      </span>
      <span className="min-w-0 truncate">— {pr.title}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        {pr.state === "open" && <ChecksBadge checks={pr.checks} />}
        {pr.state === "open" && (
          <span className="@max-[420px]:hidden">
            <ReviewBadge review={pr.review} />
          </span>
        )}
        <Age ms={pr.state === "merged" ? pr.mergedAtMs : pr.updatedAtMs} />
      </span>
    </NavRow>
  );
}

function CiIcon({ tone }: { tone: ReturnType<typeof checksSummary>["tone"] }) {
  if (tone === "success") return <CircleCheck className="size-3.5 text-emerald-400" />;
  if (tone === "failure") return <CircleX className="size-3.5 text-red-400" />;
  if (tone === "pending") return <CircleDot className="size-3.5 text-amber-300" />;
  return <CircleDashed className="size-3.5 text-muted-foreground" />;
}

function GithubActivity({ activity, activityError, branch, branchPrs }: {
  activity: RepoActivityView | null;
  activityError: string | null;
  branch: string;
  branchPrs: { prs: PullRequestView[]; fetchedAtMs: number | null; error: string };
}) {
  if (!activity) {
    return <p className="text-xs text-muted-foreground">{activityError ? `Cannot load GitHub activity: ${activityError}` : "Loading…"}</p>;
  }
  const { stats, defaultBranch: ci } = activity;
  const fetched = stats.fetchedAtMs !== null;
  const summary = ci ? checksSummary(ci.rollup) : null;
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="gh-activity">
      <div data-testid="gh-merged-stats">
        <span className="text-muted-foreground">My PRs merged: </span>
        {fetched ? (
          <>
            <b className="tabular-nums">{stats.thisMonth.merged}</b> this month · <b className="tabular-nums">{stats.lastMonth.merged}</b> last month
          </>
        ) : (
          <span className="text-muted-foreground">not fetched yet</span>
        )}
      </div>
      <div data-testid="gh-commit-stats">
        <span className="text-muted-foreground">My commits: </span>
        {fetched ? (
          <>
            <b className="tabular-nums">{stats.thisMonth.commits}</b> this month · <b className="tabular-nums">{stats.lastMonth.commits}</b> last month
          </>
        ) : (
          <span className="text-muted-foreground">not fetched yet</span>
        )}
        {stats.lastError && <span className="ml-2 text-red-400" title={stats.lastError}>(last poll failed)</span>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-testid="gh-default-branch" data-ci={summary?.tone ?? "unknown"}>
        {ci && summary ? (
          <>
            <CiIcon tone={summary.tone} />
            <span className="text-muted-foreground">default</span>
            <span className="font-mono">{ci.branch}</span>
            <span className={cn(summary.tone === "failure" && "text-red-400", summary.tone === "pending" && "text-amber-300", summary.tone === "success" && "text-emerald-400")}>
              {summary.tone === "none" ? "no checks" : summary.tone === "success" ? "passing" : summary.label}
            </span>
            <span className="text-muted-foreground">·</span>
            <Age ms={ci.committedAtMs} />
            <span className="min-w-0 truncate text-muted-foreground">{ci.headline}</span>
          </>
        ) : (
          <span className="text-muted-foreground">Default branch CI: not polled yet</span>
        )}
      </div>
      {ci?.failing.map((c) => <CheckLine key={c.url || c.name} c={c} />)}
      <div className="mt-1 text-muted-foreground">Merged in last 7 days (involving you)</div>
      {activity.recentlyMerged.length === 0 ? (
        <div className="pl-6 text-muted-foreground">none</div>
      ) : (
        activity.recentlyMerged.map((p) => <PrLine key={p.number} pr={p} prefix="m" />)
      )}
      <div className="mt-1 text-muted-foreground">
        Your PRs for <span className="font-mono">{branch || "(detached)"}</span>
        {branchPrs.error && <span className="ml-2 text-red-400" title={branchPrs.error}>(last poll failed)</span>}
      </div>
      {!branch ? null : branchPrs.fetchedAtMs === null && branchPrs.prs.length === 0 ? (
        <div className="pl-6 text-muted-foreground">checking GitHub…</div>
      ) : branchPrs.prs.length === 0 ? (
        <div className="pl-6 text-muted-foreground">none</div>
      ) : (
        branchPrs.prs.map((p) => <PrLine key={p.number} pr={p} prefix="b" />)
      )}
    </div>
  );
}

/**
 * A git repository with no remote: nothing to show from GitHub yet, and the way to put it
 * there: the publish dialog (repo.github.publish's presenter).
 */
function PublishToGitHub({ repoId }: { repoId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="no-remote">
      <p className="text-xs text-muted-foreground">No remote: this repository is only on this Mac.</p>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => {
          openPublishDialog(repoId);
        }}
        data-testid="publish-github"
      >
        <CloudUpload aria-hidden />
        Publish to GitHub
      </Button>
    </div>
  );
}

/**
 * The overview of a project without git: what it is instead of branch, status, GitHub,
 * files and log (none of which exist for it), and the Initialize Git button
 * (repo.git.init on the project, whichever selection the panel belongs to).
 */
function NoGitBody({ repoId, path }: { repoId: string; path: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-6" data-testid="overview-nogit">
      <section className="rounded-md border border-dashed px-4 py-3" data-testid="section-nogit">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Folder className="size-4 text-muted-foreground" aria-hidden />
          Not a git repository
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Threads and terminals run in this folder. Branches, worktrees, diffs and pull requests need git: initializing makes an empty first commit on the
          default branch.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          disabled={busy}
          data-testid="init-git"
          onClick={() => {
            setBusy(true);
            void runCommand("repo.git.init", {}, worktreeContext(repoId, path)).finally(() => {
              setBusy(false);
            });
          }}
        >
          <GitBranchPlus aria-hidden />
          Initialize Git
        </Button>
      </section>
    </div>
  );
}

/**
 * The overview's body for one worktree, in a side panel tab (WorktreePanelView): it
 * does not take focus when it mounts and is not the content pane's focus root; the
 * panel is a CSS container, so its rows narrow by container query.
 */
function OverviewBody({ repo, wt }: { repo: RepoView; wt: WorktreeView }) {
  const slug = repo.githubSlug.toLowerCase();
  const detailEntry = useResource(worktreeDetailResource, detailKey(repo.id, wt.path));
  const activityEntry = useResource(repoActivityResource, slug || null);
  const branchEntry = useResource(branchPullRequestsResource, slug && wt.branch ? branchKey(slug, wt.branch) : null);
  const detail: WorktreeDetailView | null = detailEntry?.data ?? null;
  const activity = activityEntry?.data ?? null;
  const branchPrs = { prs: branchEntry?.data?.pullRequests ?? [], fetchedAtMs: branchEntry?.data?.fetchedAtMs ?? null, error: branchEntry?.data?.lastError || branchEntry?.error || "" };
  // A tracked repository's default branch is in every poll: the last poll confirms it.
  const ci = activity?.defaultBranch ?? null;
  const ciFreshness = useFreshness(ci?.fetchedAtMs ?? null, ci?.lastError ?? "", activity?.tracked ?? false);
  const ciFresh = ci ? ciFreshness : null;

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const fileRows = useMemo(() => buildFileRows(detail?.files ?? [], overrides), [detail, overrides]);
  const totals = useMemo(() => fileTotals(detail?.files ?? []), [detail]);

  const items_ = useMemo<NavItem[]>(() => {
    const out: NavItem[] = [];
    for (const c of activity?.defaultBranch?.failing ?? []) out.push({ key: `c:${c.url || c.name}`, activate: () => void openUrl(c.url) });
    // Pull request rows open in the side panel; cmd+Enter (and cmd+click) on GitHub.
    const pr = (key: string, p: PullRequestView): NavItem => ({ key, activate: () => void openPullRequestInPanel({ slug: p.repoSlug || slug, number: p.number }), secondary: () => void openUrl(p.url) });
    for (const p of activity?.recentlyMerged ?? []) out.push(pr(`m:${String(p.number)}`, p));
    for (const p of branchPrs.prs) out.push(pr(`b:${String(p.number)}`, p));
    for (const r of fileRows) {
      if (r.kind === "dir") {
        out.push({
          key: r.key,
          toggle: (open) => {
            if (r.expanded === open) return false;
            setOverrides((o) => ({ ...o, [r.path]: open }));
            return true;
          },
          activate: () => {
            setOverrides((o) => ({ ...o, [r.path]: !r.expanded }));
          },
        });
      } else out.push({ key: r.key });
    }
    for (const e of detail?.log ?? []) out.push({ key: `l:${e.sha}`, activate: slug ? () => void openUrl(`https://github.com/${slug}/commit/${e.sha}`) : undefined });
    return out;
  }, [activity, branchPrs.prs, fileRows, detail, slug]);
  const nav = useNav(items_);

  const expandAll = (open: boolean) => {
    const dirs: Record<string, boolean> = {};
    for (const f of detail?.files ?? []) {
      const parts = f.path.replace(/\/$/, "").split("/");
      for (let i = 1; i < parts.length; i++) dirs[parts.slice(0, i).join("/")] = open;
    }
    setOverrides(dirs);
  };

  return (
    <NavProvider value={nav.ctx}>
      <div
        tabIndex={0}
        role="listbox"
        aria-label="Worktree overview"
        aria-activedescendant={nav.activeDescendant}
        className="flex flex-col gap-4 outline-none"
        data-testid="overview-list"
        onKeyDown={(e) => {
          if ((e.key === "e" || e.key === "E") && !e.metaKey && !e.ctrlKey && !e.altKey) {
            expandAll(e.key === "e");
            e.preventDefault();
            return;
          }
          nav.onKeyDown(e);
        }}
      >
        <SyncLine st={wt.status} />
        <Section title="GitHub activity" testId="section-github" extra={ciFresh && <Freshness fetchedAtMs={ciFresh.fetchedAtMs} lastError={ciFresh.lastError} staleAfterMs={5 * 60_000} testId="gh-updated" />}>
          {slug ? (
            <GithubActivity activity={activity} activityError={activityEntry?.error ?? null} branch={wt.branch} branchPrs={branchPrs} />
          ) : isRemoteless(repo) ? (
            <PublishToGitHub repoId={repo.id} />
          ) : (
            <p className="text-xs text-muted-foreground">No GitHub remote: origin is not on github.com.</p>
          )}
        </Section>
        <Section
          testId="section-files"
          title={
            detail ? (
              <>
                Files{" "}
                <span className="font-normal text-muted-foreground tabular-nums">
                  ({totals.count} {totals.count === 1 ? "file" : "files"}, <span className="text-emerald-400">+{totals.added}</span>{" "}
                  <span className="text-red-400">−{totals.deleted}</span>
                  {detail.filesTruncated && ", truncated"})
                </span>
              </>
            ) : (
              "Files"
            )
          }
          extra={
            detail && (
              <span className="flex items-center gap-2">
                <span className="font-mono">{detail.baseRef ? `vs ${detail.baseRef}` : "uncommitted only (no base)"}</span>
                <span>·</span>
                <Freshness fetchedAtMs={detail.computedAtMs} lastError={detail.error || detailEntry?.error || ""} staleAfterMs={10 * 60_000} testId="files-computed" />
              </span>
            )
          }
        >
          {!detail ? (
            <p className="text-xs text-muted-foreground">{detailEntry?.error ? `Cannot compute: ${detailEntry.error}` : "Computing…"}</p>
          ) : fileRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No changes against {detail.baseRef || "HEAD"}.</p>
          ) : (
            <RowList rows={fileRows} rowKey={(r) => r.key} rowHeight={FILE_ROW_H} render={(r) => <FileLine row={r} />} testId="files-list" />
          )}
        </Section>
        <Section
          testId="section-log"
          title={
            detail && detail.log.length > 0 ? (
              <>
                Log <span className="font-normal text-muted-foreground tabular-nums">({detail.logTotal} {detail.logTotal === 1 ? "commit" : "commits"}{detail.logTotal > detail.log.length && `, newest ${String(detail.log.length)}`})</span>
              </>
            ) : (
              <>
                Log <span className="font-normal text-muted-foreground">(no commits in range)</span>
              </>
            )
          }
        >
          {detail && detail.log.length > 0 && <RowList rows={detail.log} rowKey={(e) => `l:${e.sha}`} rowHeight={LOG_ROW_H} render={(e) => <LogLine e={e} />} testId="log-list" />}
        </Section>
      </div>
    </NavProvider>
  );
}

/**
 * A worktree's overview, the side panel's Worktree surface (surfaces/worktree.ts): a
 * compact header (project@branch, path), then sync state, GitHub activity, files and log.
 * A project without git shows what it is instead, with Initialize Git. The threads and
 * terminals in the worktree are not listed: the sidebar is the thread list.
 */
export function WorktreePanelView({ repoId, path }: { repoId: string; path: string }) {
  const repo = useReposStore((s) => s.byId[repoId]);
  const wt = useReposStore((s) => findWorktree(s, repoId, path));
  const noGit = repo?.git === false;
  return (
    // @container: log, check and pull request rows narrow with the panel.
    <div className="@container flex min-w-0 flex-col gap-3 px-4 py-3 @max-[340px]:px-3" data-testid="worktree-surface" data-repo={repoId} data-path={path} data-git={repo ? !noGit : undefined}>
      <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border pb-2" data-testid="worktree-surface-header">
        <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {noGit ? <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <GitBranch className="size-4 shrink-0 text-violet-400" aria-hidden />}
          <span className="flex min-w-0 items-center gap-2 truncate" data-testid="worktree-surface-title">
            {repo?.name ?? repoId}
            {noGit ? (
              <NoGitBadge />
            ) : (
              <>
                <span className="text-muted-foreground">@</span>
                {wt?.branch || (wt?.head ? wt.head.slice(0, 8) : "")}
              </>
            )}
          </span>
        </h2>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={path}>
          {tildify(path)}
        </span>
      </header>
      {!repo ? (
        <p className="text-sm text-muted-foreground">Project not found.</p>
      ) : noGit ? (
        <NoGitBody repoId={repoId} path={path} />
      ) : !wt ? (
        <p className="text-sm text-muted-foreground" data-testid="worktree-surface-missing">
          This worktree is gone (removed from the workspace, or deleted).
        </p>
      ) : (
        <OverviewBody key={wt.path} repo={repo} wt={wt} />
      )}
    </div>
  );
}
