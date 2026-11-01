import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CircleCheck,
  CircleX,
  FileDiff,
  Download,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  LoaderCircle,
  TriangleAlert,
  Upload,
  WandSparkles,
} from "lucide-react";
import type { PullRequestView } from "@/api/gh";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { fileTotals } from "@/components/changes/files";
import {
  commits,
  files,
  fixPrompt,
  gitButtonsBlocked,
  gitStateRow,
  operationLabel,
  operationStep,
  prRows,
  rebasePrompt,
  RESOLVE_PROMPT,
  type PrInput,
  type PrRow,
} from "@/lib/threadInfo";
import { isWorkingThread } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { runCommand } from "@/stores/commands";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { copyPullRequestLink, openPullRequestInPanel } from "@/stores/prPanel";
import { useProjectsStore } from "@/stores/projects";
import { copyBranchName, pendingKey, runOnce, sendThreadPrompt, useCardPending, useCheckoutShared, useWatchKeys } from "@/stores/threadInfo";
import { threadContext } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";
import { openChangesTab } from "@/stores/changesPanel";
import { DiffCounts, Group, HOVER_CARD, Row, RowMore, SubLine } from "./Row";
import { useMembers } from "./useMembers";

const SEP = "\u0000";

/** The cwd's checkout as the git rows read it (the projects store's worktree at the cwd). */
function useCwdCheckout(threadId: string) {
  const projectId = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const git = useProjectsStore((s) => s.byId[projectId]?.git ?? false);
  const remotes = useProjectsStore((s) => s.byId[projectId]?.remotes.length ?? 0);
  const wt = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.path === cwd));
  return { projectId, cwd, git, hasRemote: remotes > 0, wt };
}

/** A small button at a row's end (Fix, Resolve, Rebase): it sends the thread a prompt. */
function RowButton({
  label,
  onClick,
  disabled = false,
  reason,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  reason?: string | null;
  testId: string;
}) {
  const button = (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex h-5.5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption-sm text-cf-text hover:bg-cf-text/10 disabled:text-cf-text-muted disabled:hover:bg-transparent [&_svg]:size-3"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        // A double click's second click is not a second send (the first may have settled already).
        if (e.detail > 1) return;
        onClick();
      }}
    >
      <WandSparkles aria-hidden />
      {label}
    </button>
  );
  // A disabled button gets no pointer events: its tooltip sits on a span around it.
  return reason ? (
    <Tip label={reason} side="left">
      <span className="inline-flex">{button}</span>
    </Tip>
  ) : (
    button
  );
}

/**
 * The branch checked out at the cwd (HEAD), ahead and behind its upstream ("not pushed"
 * without one, "no remote" without a remote). A click copies it; the hover card names the
 * branch the thread was made for when the checkout moved, and the upstream.
 */
function BranchRow({ threadId }: { threadId: string }) {
  const { wt, hasRemote } = useCwdCheckout(threadId);
  const created = useThreadsStore((s) => (s.byId[threadId]?.createdWorktree ? s.byId[threadId].branch : ""));
  if (!wt) return null;
  const branch = wt.detached ? wt.head.slice(0, 7) : wt.branch;
  if (!branch) return null;
  const st = wt.status;
  const meta = !hasRemote ? (
    <span data-testid="ti-branch-noremote">no remote</span>
  ) : !st.upstream ? (
    <span data-testid="ti-branch-unpushed">not pushed</span>
  ) : st.ahead + st.behind > 0 ? (
    <>
      {st.ahead > 0 && (
        <span className="inline-flex items-center gap-px text-cf-success-text" data-testid="ti-branch-ahead">
          <ArrowUp aria-hidden />
          {st.ahead}
        </span>
      )}
      {st.behind > 0 && (
        <span className="inline-flex items-center gap-px text-cf-warning-text" data-testid="ti-branch-behind">
          <ArrowDown aria-hidden />
          {st.behind}
        </span>
      )}
    </>
  ) : null;
  const moved = created !== "" && created !== wt.branch;
  const tip = (
    <div className={HOVER_CARD}>
      {moved && (
        <div>
          Created for <span className="text-code">{created}</span>
        </div>
      )}
      <div>
        {st.upstream ? (
          <>
            Upstream <span className="text-code">{st.upstream}</span>
          </>
        ) : hasRemote ? (
          "No upstream: not pushed yet"
        ) : (
          "No remote"
        )}
      </div>
      <div className="text-cf-text-muted">Click to copy the branch name</div>
    </div>
  );
  return (
    <Tip label={tip} side="left">
      <Row icon={<GitBranch />} meta={meta} onActivate={() => void copyBranchName(branch)} testId="ti-branch" data-branch={branch}>
        <span className="text-code">{branch}</span>
      </Row>
    </Tip>
  );
}

const PR_ICON: Record<PrRow["state"], ReactNode> = {
  open: <GitPullRequest className="text-cf-success-text" />,
  draft: <GitPullRequestDraft className="text-cf-text-muted" />,
  merged: <GitMerge className="text-cf-highlight-text" />,
};

const CHECK_ICON: Record<"ok" | "failed" | "running", ReactNode> = {
  ok: <CircleCheck className="text-cf-success-text" aria-hidden />,
  failed: <CircleX className="text-cf-error-text" aria-hidden />,
  running: <LoaderCircle className="animate-spin text-cf-warning-text" aria-hidden />,
};

/** One linked pull request: title; #n and its status (→ #base when stacked); its project when not the cwd's. A click opens its tab; the ellipsis offers GitHub and Copy URL. */
function PrRowView({ row }: { row: PrRow }) {
  const ref = { slug: row.slug, number: row.number };
  return (
    <Row
      icon={PR_ICON[row.state]}
      tall
      onActivate={() => void openPullRequestInPanel(ref)}
      trailing={
        <RowMore label="Pull request options" testId="ti-pr-more" menuTestId="ti-pr-menu">
          <DropdownMenuItem onSelect={() => void openUrl(row.url)} data-testid="ti-pr-github">
            Open on GitHub
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyPullRequestLink(ref, row.url)} data-testid="ti-pr-copy">
            Copy URL
          </DropdownMenuItem>
        </RowMore>
      }
      testId="ti-pr"
      data-number={row.number}
      data-state={row.state}
      className="[&>span:first-child]:self-start [&>span:first-child]:mt-0.5"
    >
      <span className="truncate" data-testid="ti-pr-title">
        {row.title}
      </span>
      <SubLine testId="ti-pr-line">
        <span className="tabular-nums">#{row.number}</span>
        {row.check.icon && CHECK_ICON[row.check.icon]}
        <span>{row.check.word}</span>
        {row.stackedOn !== null && (
          <span className="inline-flex items-center gap-0.5" data-testid="ti-pr-stacked">
            <ArrowRight aria-hidden />#{row.stackedOn}
          </span>
        )}
      </SubLine>
      {row.project && <SubLine testId="ti-pr-project">{row.project}</SubLine>}
    </Row>
  );
}

/** The thread's linked pull requests (lib/threadInfo prRows), each detail watched while the card shows. */
function PrRows({ threadId }: { threadId: string }) {
  const { cwdProjectId, members } = useMembers(threadId);
  const links = useThreadsStore(useShallow((s) => (s.byId[threadId]?.linkedPullRequests ?? []).map((l) => [l.slug, String(l.number), l.url].join(SEP))));
  const keys = useMemo(
    () =>
      links.map((l) => {
        const [slug = "", n = "0"] = l.split(SEP);
        return pullRequestKey(slug, Number(n));
      }),
    [links],
  );
  useWatchKeys(pullRequestDetailResource.watch, keys);
  const details = pullRequestDetailResource.store(useShallow((s) => keys.map((k): PullRequestView | null => s.entries[k]?.data?.pullRequest ?? null)));
  const projectKey = useProjectsStore(useShallow((s) => members.map((id) => [id, s.byId[id]?.name ?? id, s.byId[id]?.githubSlug ?? ""].join(SEP))));
  const rows = useMemo(() => {
    const projects = new Map<string, { id: string; name: string }>();
    for (const p of projectKey) {
      const [id = "", name = "", slug = ""] = p.split(SEP);
      if (slug) projects.set(slug.toLowerCase(), { id, name });
    }
    const inputs: PrInput[] = links.map((l, i) => {
      const [slug = "", n = "0", url = ""] = l.split(SEP);
      return { slug, number: Number(n), url, pr: details[i] ?? null };
    });
    return prRows(inputs, projects, members, cwdProjectId);
  }, [links, details, projectKey, members, cwdProjectId]);
  return (
    <>
      {rows.map((r) => (
        <PrRowView key={`${r.slug}#${String(r.number)}`} row={r} />
      ))}
    </>
  );
}

/**
 * The git state row (lib/threadInfo gitStateRow): conflicts with Resolve, a diverged
 * upstream with Fix, an operation in progress, Push, Pull, or Rebase onto the base. Push,
 * Pull and Rebase wait while a model works on the branch (gitButtonsBlocked).
 */
function GitStateRowView({ threadId }: { threadId: string }) {
  const { cwd, wt } = useCwdCheckout(threadId);
  const working = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t ? isWorkingThread(t) : false;
  });
  const agentsRunning = useThreadsStore((s) => s.byId[threadId]?.agentsRunning ?? 0);
  const collision = useCheckoutShared(threadId, cwd);
  // One git state row at a time: one pending key for its button (or the row, for Push and Pull).
  const key = pendingKey(threadId, "git");
  const pending = useCardPending(key);
  const row = gitStateRow(wt?.status ?? null);
  if (!row) return null;
  const blocked = gitButtonsBlocked({ working, agentsRunning, collision });
  const send = (text: string) => void runOnce(key, () => sendThreadPrompt(threadId, text));
  const git = (name: "git.push" | "git.pull") => () => void runOnce(key, () => runCommand(name, { worktree: cwd }, threadContext(threadId)));
  switch (row.kind) {
    case "conflicts":
      return (
        <Row
          icon={<TriangleAlert className="text-cf-error-text" />}
          meta={files(row.files)}
          trailing={
            <RowButton
              label="Resolve"
              testId="ti-git-resolve"
              disabled={pending}
              onClick={() => {
                send(RESOLVE_PROMPT);
              }}
            />
          }
          testId="ti-git"
          data-kind={row.kind}
        >
          Conflicts
        </Row>
      );
    case "diverged":
      return (
        <Row
          icon={<TriangleAlert className="text-cf-warning-text" />}
          meta={`${String(row.ahead)} ahead · ${String(row.behind)} behind`}
          trailing={
            <RowButton
              label="Fix"
              testId="ti-git-fix"
              disabled={pending}
              onClick={() => {
                send(fixPrompt(row.ahead, row.behind));
              }}
            />
          }
          testId="ti-git"
          data-kind={row.kind}
        >
          Diverged
        </Row>
      );
    case "operation": {
      const step = operationStep(row.step, row.total);
      return (
        <Row icon={<TriangleAlert className="text-cf-warning-text" />} testId="ti-git" data-kind={row.kind}>
          <span className="text-cf-warning-text">{operationLabel(row.operation)}</span>
          {step && <span className="text-cf-text-muted tabular-nums"> {step}</span>}
        </Row>
      );
    }
    case "push":
    case "pull": {
      const push = row.kind === "push";
      const content = (
        <Row
          icon={push ? <Upload /> : <Download />}
          meta={push ? commits(row.ahead) : `${commits(row.behind)} behind`}
          onActivate={blocked || pending ? undefined : git(push ? "git.push" : "git.pull")}
          hoverable={blocked !== null}
          testId="ti-git"
          data-kind={row.kind}
          data-disabled={blocked || pending ? "" : undefined}
          data-pending={pending ? "" : undefined}
          aria-disabled={blocked || pending ? true : undefined}
        >
          <span className={cn((blocked || pending) && "text-cf-text-muted")}>{push ? "Push" : "Pull"}</span>
        </Row>
      );
      return blocked ? (
        <Tip label={blocked} side="left" data-testid="ti-git-blocked">
          {content}
        </Tip>
      ) : (
        content
      );
    }
    case "rebase":
      return (
        <Row
          icon={<Download />}
          meta={`${String(row.behind)} behind`}
          trailing={
            <RowButton
              label="Rebase"
              testId="ti-git-rebase"
              disabled={blocked !== null || pending}
              reason={blocked}
              onClick={() => {
                send(rebasePrompt(row.base));
              }}
            />
          }
          testId="ti-git"
          data-kind={row.kind}
        >
          Rebase onto <span className="text-code">{row.base}</span>
        </Row>
      );
  }
}

/** A git member's changes against its base, as the Changes tab's heading counts them. */
interface MemberChanges {
  projectId: string;
  path: string;
  added: number;
  deleted: number;
  count: number;
}

/**
 * Changes: added and deleted lines and files against the base, as the Changes tab counts
 * them (a click opens the cwd's Changes tab, whose list opens each file's Diff tab). With several projects:
 * the lines over all, the dirty projects counted, and a fold with a row per dirty project.
 * "No changes" when clean; nothing until every checkout's detail has been read.
 */
function ChangesRow({ threadId }: { threadId: string }) {
  const { cwdProjectId, members, paths } = useMembers(threadId);
  const gitMembers = useProjectsStore(useShallow((s) => members.filter((id) => s.byId[id]?.git && paths[id])));
  const keys = useMemo(() => gitMembers.map((id) => detailKey(id, paths[id] ?? "")), [gitMembers, paths]);
  useWatchKeys(worktreeDetailResource.watch, keys);
  const totals = worktreeDetailResource.store(
    useShallow((s) =>
      keys.map((k) => {
        const e = s.entries[k];
        const f = e?.data?.files;
        // Not read yet: "" (the row waits); a read that failed counts as no changes.
        if (!f) return e?.error ? "0,0,0" : "";
        const t = fileTotals(f);
        return `${String(t.added)},${String(t.deleted)},${String(t.count)}`;
      }),
    ),
  );
  const [open, setOpen] = useState(false);
  const cwd = paths[cwdProjectId] ?? "";
  // Nothing until every checkout's detail is read: not "No changes" first, then counts.
  if (keys.length === 0 || totals.some((t) => t === "")) return null;
  const dirty: MemberChanges[] = gitMembers.flatMap((id, i) => {
    const [added = 0, deleted = 0, count = 0] = (totals[i] ?? "").split(",").map(Number);
    return count > 0 ? [{ projectId: id, path: paths[id] ?? "", added, deleted, count }] : [];
  });
  const several = members.length > 1;
  const added = dirty.reduce((n, d) => n + d.added, 0);
  const deleted = dirty.reduce((n, d) => n + d.deleted, 0);
  const count = dirty.reduce((n, d) => n + d.count, 0);
  const openTab = () => {
    if (cwd) openChangesTab("current", cwdProjectId, cwd, true);
  };
  if (dirty.length === 0) {
    return (
      <Row icon={<FileDiff />} onActivate={openTab} testId="ti-changes" data-clean="">
        <span className="text-cf-text-muted">No changes</span>
      </Row>
    );
  }
  const meta = (
    <>
      <DiffCounts added={added} deleted={deleted} />
      <span>· {several ? `${String(dirty.length)} ${dirty.length === 1 ? "project" : "projects"}` : files(count)}</span>
    </>
  );
  return (
    <>
      <Row
        icon={<FileDiff />}
        meta={meta}
        chevron={several ? (open ? "open" : "closed") : "none"}
        onActivate={
          several
            ? () => {
                setOpen((o) => !o);
              }
            : openTab
        }
        aria-expanded={several ? open : undefined}
        testId="ti-changes"
      >
        Changes
      </Row>
      {several && open && dirty.map((d) => <ChangesSubRow key={d.projectId} d={d} />)}
    </>
  );
}

function ChangesSubRow({ d }: { d: MemberChanges }) {
  const name = useProjectsStore((s) => s.byId[d.projectId]?.name ?? d.projectId);
  return (
    <Row
      sub
      meta={
        <>
          <DiffCounts added={d.added} deleted={d.deleted} />
          <span>· {d.count}</span>
        </>
      }
      onActivate={() => {
        openChangesTab("current", d.projectId, d.path);
      }}
      testId="ti-changes-project"
      data-project={d.projectId}
    >
      <span className="text-cf-text-muted">{name}</span>
    </Row>
  );
}

/** The git group: absent when the cwd's project has no git. */
export function GitGroup({ threadId }: { threadId: string }) {
  const { git, wt } = useCwdCheckout(threadId);
  if (!git || !wt) return null;
  return (
    <Group testId="ti-git-group">
      <BranchRow threadId={threadId} />
      <PrRows threadId={threadId} />
      <GitStateRowView threadId={threadId} />
      <ChangesRow threadId={threadId} />
    </Group>
  );
}
