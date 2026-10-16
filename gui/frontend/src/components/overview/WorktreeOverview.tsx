import { useMemo, useState } from "react";
import { ChevronRight, CloudUpload, Folder, GitBranch, GitBranchPlus, MessageSquare, Terminal, TriangleAlert } from "lucide-react";
import type { PullRequestView } from "@/api/gh";
import { isRemoteless, type GitStatusView, type RepoView, type WorktreeView } from "@/api/repo";
import type { LogEntryView, WorktreeDetailView } from "@/api/worktreeDetail";
import { NoGitBadge } from "@/components/projects/NoGitBadge";
import { Age, ChecksBadge, PrStateIcon, ReviewBadge } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { branchKey, branchPullRequestsResource, openUrl } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { openPublishDialog } from "@/stores/publish";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useResource } from "@/stores/resource";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { baseFact, branchPullRequest, operationStrip, originFact, otherThreads, shellsIn, shortRef, upstreamRemote, workingTreeFact, type FactPart, type FactTone } from "./facts";
import { buildFileRows, fileTotals, type FileRow } from "./files";

const FILE_ROW_H = 24;
const LOG_ROW_H = 24;
/** The Changes and Commits lists show this many rows, then scroll inside the panel. */
const MAX_ROWS = 10;

const toneText: Record<FactTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

/**
 * Who else works here, the header's third line: the other threads in this worktree (not
 * the selected one the panel belongs to) and its live terminals. Hidden when there are
 * none. Counts, not lists: the selectors return numbers, so other threads' activity does
 * not re-render the panel.
 */
function WhoElse({ path }: { path: string }) {
  const self = useUiStore((s) => (s.selection.kind === "session" ? s.selection.id : ""));
  const threads = useSessionsStore((s) => otherThreads(s, path, self));
  const shells = useTerminalsStore((s) => shellsIn(s, path));
  if (threads === 0 && shells === 0) return null;
  return (
    <div className="mt-0.5 flex items-center gap-2.5 text-caption-sm" data-testid="worktree-who" data-threads={threads} data-shells={shells}>
      {threads > 0 && (
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="size-3 shrink-0" aria-hidden />
          {threads} other {threads === 1 ? "thread" : "threads"}
        </span>
      )}
      {shells > 0 && (
        <span className="inline-flex items-center gap-1">
          <Terminal className="size-3 shrink-0" aria-hidden />
          {shells} {shells === 1 ? "shell" : "shells"}
        </span>
      )}
    </div>
  );
}

/** A rebase, merge, cherry-pick, … stopped in this worktree: full width, above the facts. */
function OperationStrip({ st }: { st: GitStatusView }) {
  const op = operationStrip(st);
  if (!op) return null;
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-destructive/45 bg-destructive/10 px-2.5 text-body-sm" data-testid="worktree-operation" data-operation={st.operation}>
      <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-semibold">{op.title}</span>
        {op.conflicts && <span> · {op.conflicts}</span>}
      </span>
      {op.step && <span className="ml-auto shrink-0 text-caption-sm tabular-nums">{op.step}</span>}
    </div>
  );
}

function Fact({ label, parts, testId }: { label: string; parts: FactPart[]; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-1.5" data-testid={testId}>
      <span className="truncate text-overline">{label}</span>
      <span className="truncate text-label font-semibold tabular-nums" data-testid={`${testId}-value`}>
        {parts.map((p, i) => (
          <span key={i} className={cn(p.small && "text-caption-sm font-normal", toneText[p.tone])}>
            {p.text}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Origin, base and working tree, side by side; two per row in a narrow panel. */
function Facts({ st, remotes }: { st: GitStatusView; remotes: readonly string[] }) {
  const base = st.baseRef ? shortRef(st.baseRef, remotes) : "";
  return (
    <div className={cn("grid gap-2 @max-[340px]:grid-cols-2", base ? "grid-cols-3" : "grid-cols-2")} data-testid="worktree-facts">
      <Fact label={upstreamRemote(st.upstream, remotes)} parts={originFact(st)} testId="fact-origin" />
      {base && <Fact label={`vs ${base}`} parts={baseFact(st)} testId="fact-base" />}
      <Fact label="working tree" parts={workingTreeFact(st)} testId="fact-tree" />
    </div>
  );
}

/**
 * The branch's pull request, one row: click opens it in the panel, cmd+click (and
 * cmd+Enter) on GitHub. Open: checks and review; a draft: "draft" and checks; merged or
 * closed: the word.
 */
function PullRequestRow({ pr }: { pr: PullRequestView }) {
  const draft = pr.state === "open" && pr.draft;
  const word = draft ? "draft" : pr.state === "open" ? "" : pr.state;
  return (
    <div data-testid="worktree-pr" data-number={pr.number} data-state={draft ? "draft" : pr.state}>
      <NavRow navKey="pr" activateOnClick onCmdClick={() => void openUrl(pr.url)} className="flex h-9 min-w-0 items-center gap-2 rounded-lg border px-2.5 text-body-sm">
        <PrStateIcon state={pr.state} draft={pr.draft} />
        <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.number}</span>
        <span className="min-w-0 truncate">{pr.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {word && <span className="text-caption">{word}</span>}
          {pr.state === "open" && pr.checks.total > 0 && <ChecksBadge checks={pr.checks} />}
          {pr.state === "open" && !draft && pr.review && (
            <span className="@max-[340px]:hidden">
              <ReviewBadge review={pr.review} />
            </span>
          )}
          <Age ms={pr.state === "merged" ? pr.mergedAtMs : pr.updatedAtMs} />
        </span>
      </NavRow>
    </div>
  );
}

const statusColor: Record<string, string> = {
  A: "text-success",
  M: "text-warning",
  D: "text-destructive",
  R: "text-info",
  C: "text-info",
  T: "text-info",
  U: "text-destructive",
  "?": "text-muted-foreground",
};

/**
 * A changed file: status letter, path, then + and − in fixed right-aligned columns
 * (blank at zero) so they line up down the list. The directory is muted and truncates
 * from its start (rtl box; the LRMs keep its slashes in place) so the name stays visible.
 */
function FileLine({ row }: { row: FileRow }) {
  return (
    <NavRow
      navKey={row.key}
      tip={row.oldPath ? `${row.oldPath} → ${row.path}` : row.path}
      className="grid h-full grid-cols-[1.25rem_minmax(0,1fr)_5ch_5ch] items-center gap-x-2 px-1.5 text-body-sm font-mono"
    >
      <span className={cn("text-center", statusColor[row.status] ?? "text-muted-foreground")} data-status={row.status}>
        {row.status}
      </span>
      <span className="flex min-w-0 items-center" data-testid="file-path">
        {row.dir && <span className="min-w-0 truncate text-left text-muted-foreground [direction:rtl]" data-testid="file-dir">{`‎${row.dir}‎`}</span>}
        <span className="max-w-full shrink-0 truncate" data-testid="file-name">
          {row.name}
        </span>
        {row.conflict && <span className="ml-1.5 shrink-0 text-caption-sm text-destructive">conflict</span>}
      </span>
      <span className="text-right text-success tabular-nums" data-testid="file-added">
        {row.added > 0 ? `+${String(row.added)}` : row.binary && row.deleted === 0 ? <span className="text-muted-foreground">bin</span> : ""}
      </span>
      <span className="text-right text-destructive tabular-nums" data-testid="file-deleted">
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
      <span className="font-mono text-warning/80">{e.shortSha}</span>
      <span className="truncate">{e.subject}</span>
      <Age ms={e.authoredAtMs} className="text-right" />
      <span className="truncate text-muted-foreground @max-[420px]:hidden">{e.authorName}</span>
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
            {totals.count} {totals.count === 1 ? "file" : "files"} · <span className="text-success">+{totals.added}</span> <span className="text-destructive">−{totals.deleted}</span>
          </span>
        )}
        {detail?.error && (
          <Tip label={detail.error}>
            <span className="shrink-0 text-caption text-destructive">refresh failed</span>
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
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
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
 * A git repository with no remote: nothing to show from GitHub yet, and the way to put it
 * there: the publish dialog (repo.github.publish's presenter).
 */
function PublishToGitHub({ repoId }: { repoId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="no-remote">
      <p className="text-caption">No remote: this repository is only on this Mac.</p>
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
      <section className="rounded-lg border border-dashed px-4 py-3" data-testid="section-nogit">
        <h2 className="flex items-center gap-2 text-heading">
          <Folder className="size-4 text-muted-foreground" aria-hidden />
          Not a git repository
        </h2>
        <p className="mt-1 text-caption">
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
 * does not take focus when it mounts and is not the content pane's focus root. Read-only:
 * the git operation in progress, the three facts, the branch's pull request, the changes
 * and the commits. Repository-wide GitHub data is the Projects page's.
 */
function OverviewBody({ repo, wt }: { repo: RepoView; wt: WorktreeView }) {
  const slug = repo.githubSlug.toLowerCase();
  const st = wt.status;
  const detailEntry = useResource(worktreeDetailResource, detailKey(repo.id, wt.path));
  const branchEntry = useResource(branchPullRequestsResource, slug && wt.branch ? branchKey(slug, wt.branch) : null);
  const detail: WorktreeDetailView | null = detailEntry?.data ?? null;
  const branchPrs = branchEntry?.data?.pullRequests;
  const pr = useMemo(() => branchPullRequest(branchPrs ?? []), [branchPrs]);
  const fileRows = useMemo(() => buildFileRows(detail?.files ?? []), [detail]);
  const base = detail?.baseRef ? shortRef(detail.baseRef, repo.remotes) : "";
  const showCommits = detail !== null && detail.logTotal > 0;
  const [commitsOpen, setCommitsOpen] = useState(false);

  const items = useMemo<NavItem[]>(() => {
    const out: NavItem[] = [];
    // The pull request opens in the side panel; cmd+Enter (and cmd+click) on GitHub.
    if (pr) out.push({ key: "pr", activate: () => void openPullRequestInPanel({ slug: pr.repoSlug || slug, number: pr.number }), secondary: () => void openUrl(pr.url) });
    // File rows have no action yet (the Diff surface is to come): the cursor only.
    for (const r of fileRows) out.push({ key: r.key });
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
  }, [pr, fileRows, showCommits, commitsOpen, detail, slug]);
  const nav = useNav(items);

  return (
    <NavProvider value={nav.ctx}>
      <div
        tabIndex={0}
        role="listbox"
        aria-label="Worktree overview"
        aria-activedescendant={nav.activeDescendant}
        className="flex flex-col gap-3 outline-none"
        data-testid="overview-list"
        onKeyDown={nav.onKeyDown}
      >
        <OperationStrip st={st} />
        <Facts st={st} remotes={repo.remotes} />
        {st.error && (
          <Tip label={st.error} align="start">
            <span className="self-start text-caption text-destructive" data-testid="status-error">
              git status failed
            </span>
          </Tip>
        )}
        {pr ? <PullRequestRow pr={pr} /> : isRemoteless(repo) ? <PublishToGitHub repoId={repo.id} /> : null}
        <Changes detail={detail} error={detailEntry?.error ?? ""} rows={fileRows} base={base} />
        {showCommits && <Commits detail={detail} base={base} open={commitsOpen} />}
      </div>
    </NavProvider>
  );
}

/**
 * A worktree's overview, the side panel's Worktree surface (surfaces/worktree.ts): a
 * compact header (project@branch, path, who else works here), then what matters about
 * this worktree (OverviewBody). A project without git shows what it is instead, with
 * Initialize Git. The surface is its own CSS container: the facts wrap, and the header's
 * rule spans the panel border to border, by its width.
 */
export function WorktreePanelView({ repoId, path }: { repoId: string; path: string }) {
  const repo = useReposStore((s) => s.byId[repoId]);
  const wt = useReposStore((s) => findWorktree(s, repoId, path));
  const noGit = repo?.git === false;
  return (
    <div className="@container min-w-0" data-testid="worktree-surface" data-repo={repoId} data-path={path} data-git={repo ? !noGit : undefined}>
      <div className="flex min-w-0 flex-col gap-3 px-4 py-3 @max-[340px]:px-3">
        <header className="-mx-4 flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pb-2 @max-[340px]:-mx-3 @max-[340px]:px-3" data-testid="worktree-surface-header">
          <h2 className="flex min-w-0 items-center gap-1.5 text-heading">
            {noGit ? <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <GitBranch className="size-4 shrink-0 text-highlight" aria-hidden />}
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
          <Tip label={path} align="start">
            <span className="min-w-0 truncate text-caption font-mono">{tildify(path)}</span>
          </Tip>
          <WhoElse path={path} />
        </header>
        {!repo ? (
          <p className="text-body text-muted-foreground">Project not found.</p>
        ) : noGit ? (
          <NoGitBody repoId={repoId} path={path} />
        ) : !wt ? (
          <p className="text-body text-muted-foreground" data-testid="worktree-surface-missing">
            This worktree is gone (removed from the workspace, or deleted).
          </p>
        ) : (
          <OverviewBody key={wt.path} repo={repo} wt={wt} />
        )}
      </div>
    </div>
  );
}
