import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { FileDiff, Layers, SquarePen, SquareTerminal } from "lucide-react";
import { ActionsMenu } from "@/components/actions/ActionsMenu";
import { ChecksBadge, PrStateIcon } from "@/components/prs/PrBits";
import { Tip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { changesCell, checkoutThreads, projectWorktreeKey, syncCell, threadsCell } from "@/lib/projects";
import { worktreeBranch } from "@/lib/threadRow";
import { useProjectActionIds } from "@/stores/actions";
import { openChangesTab } from "@/stores/changesPanel";
import { runCommand } from "@/stores/commands";
import { composeIn } from "@/stores/compose";
import { worktreeContext } from "@/stores/context";
import { branchKey, branchPullRequestsResource } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { newTerminalIn, removeWorktree } from "@/stores/projectActions";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Pill, StatusDot, type PillTone } from "./bits";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { RowAction } from "./RowAction";

/**
 * Which columns the table has: Sync with a remote and room for it, Pull request on
 * GitHub; `narrow` (the content pane under PROJECT_NARROW_BELOW) tightens them and lays the
 * row actions over the row's end instead of keeping a column for them.
 */
export interface CheckoutColumns {
  sync: boolean;
  pr: boolean;
  narrow: boolean;
}

function gridColumns(c: CheckoutColumns): string {
  if (c.narrow) return ["minmax(0,1fr)", "7rem", "4.5rem", ...(c.sync ? ["6.5rem"] : []), ...(c.pr ? ["6.5rem"] : [])].join(" ");
  return ["minmax(0,1fr)", "8rem", "6.5rem", ...(c.sync ? ["8rem"] : []), ...(c.pr ? ["9rem"] : []), "7.5rem"].join(" ");
}

/** Open pull requests read green, drafts neutral, merged blue, closed red (the pill's tint). */
function prTone(state: string, draft: boolean): PillTone {
  if (state === "merged") return "info";
  if (state === "closed") return "error";
  return draft ? "neutral" : "success";
}

/** The viewer's pull request on the branch (watched while shown), or null. */
function useBranchPr(projectId: string, branch: string) {
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const isDefault = useProjectsStore((s) => s.byId[projectId]?.defaultBranch === branch);
  const entry = useResource(branchPullRequestsResource, slug && branch && !isDefault ? branchKey(slug, branch) : null);
  const pr = entry?.data?.pullRequests[0] ?? null;
  return pr ? { ...pr, repoSlug: pr.repoSlug || slug } : null;
}

function PrCell({ projectId, branch }: { projectId: string; branch: string }) {
  const pr = useBranchPr(projectId, branch);
  if (!pr) return <span className="text-caption text-cf-text-muted">—</span>;
  return (
    <Tip label={`#${String(pr.number)} ${pr.title}`}>
      <button
        type="button"
        tabIndex={-1}
        className="flex w-fit"
        data-testid="worktree-pr"
        data-state={pr.state}
        onClick={(e) => {
          e.stopPropagation();
          openPullRequestInPanel({ slug: pr.repoSlug, number: pr.number });
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
      >
        <Pill tone={prTone(pr.state, pr.draft)} className="hover:brightness-110">
          <PrStateIcon state={pr.state} draft={pr.draft} />#{pr.number}
          {pr.state === "open" && <ChecksBadge checks={pr.checks} compact />}
        </Pill>
      </button>
    </Tip>
  );
}

/** worktree.reveal: the checkout in Finder. */
function revealCheckout(projectId: string, path: string): void {
  void runCommand("worktree.reveal", { worktree: path }, worktreeContext(projectId, path));
}

async function copyPath(path: string): Promise<void> {
  try {
    await copyText(path);
    toast.success("Path copied", { description: path });
  } catch {
    toast.error("Copy failed");
  }
}

/** The row's menu: what the hover actions do, its pull request, Finder and the path, then Remove worktree (not on main). */
function rowMenu(projectId: string, path: string, isMain: boolean, pr: { slug: string; number: number } | null): OverflowItem[] {
  const items: OverflowItem[] = [
    { label: "New thread here", testId: "worktree-menu-new-thread", onSelect: () => { composeIn(projectId, path); } },
    { label: "New terminal here", testId: "worktree-menu-new-terminal", onSelect: () => void newTerminalIn(projectId, path) },
    { label: "Show changes", testId: "changes-show-panel", onSelect: () => { openChangesTab("current", projectId, path); } },
  ];
  if (pr) items.push({ label: `Open pull request #${String(pr.number)}`, testId: "worktree-open-pr", onSelect: () => { openPullRequestInPanel(pr); } });
  items.push(
    "separator",
    { label: "Open in Finder", testId: "worktree-reveal", onSelect: () => { revealCheckout(projectId, path); } },
    { label: "Copy path", testId: "worktree-copy-path", onSelect: () => void copyPath(path) },
  );
  if (!isMain) items.push("separator", { label: "Remove worktree", destructive: true, testId: "worktree-remove", onSelect: () => void removeWorktree(projectId, path) });
  return items;
}

function RowMenu({ projectId, path, isMain, branch }: { projectId: string; path: string; isMain: boolean; branch: string }) {
  const pr = useBranchPr(projectId, branch);
  return <OverflowMenu label="More actions" testId="worktree-more" items={rowMenu(projectId, path, isMain, pr ? { slug: pr.repoSlug, number: pr.number } : null)} />;
}

function CheckoutRow({ projectId, path, columns }: { projectId: string; path: string; columns: CheckoutColumns }) {
  const branch = useProjectsStore((s) => worktreeBranch(s, projectId, path));
  const realBranch = useProjectsStore((s) => findWorktree(s, projectId, path)?.branch ?? "");
  const isMain = useProjectsStore((s) => findWorktree(s, projectId, path)?.isMain ?? false);
  const changes = useProjectsStore((s) => {
    const st = findWorktree(s, projectId, path)?.status;
    return st ? changesCell(st) : "";
  });
  const sync = useProjectsStore((s) => {
    const st = findWorktree(s, projectId, path)?.status;
    return st ? syncCell(st) : "";
  });
  const { working, idle, workspaceId } = useThreadsStore(useShallow((s) => {
    const t = checkoutThreads(s, path);
    return { working: t.working, idle: t.idle, workspaceId: t.workspaceId };
  }));
  const workspace = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? "") : ""));
  const hasActions = useProjectActionIds(projectId).length > 0;
  return (
    <NavRow navKey={projectWorktreeKey(projectId, path)} activateOnClick className="group/row rounded-none border-b border-cf-divider last:border-b-0" tip={path} tipWhenTruncated>
      <span className="relative grid min-h-11 w-full items-center gap-x-3 px-3.5" style={{ gridTemplateColumns: gridColumns(columns) }} data-testid="project-worktree" data-path={path} data-main={isMain || undefined}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot live={working > 0} />
          <span className="min-w-0 truncate text-code" data-testid="worktree-branch">
            {branch}
          </span>
          {isMain && (
            <Pill small data-testid="worktree-main-tag">
              main
            </Pill>
          )}
          {workspace && (
            <Pill small data-testid="worktree-workspace-tag">
              <Layers aria-hidden />
              {workspace}
            </Pill>
          )}
        </span>
        <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-threads">
          {threadsCell(working, idle)}
        </span>
        <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-changes-cell">
          {changes}
        </span>
        {columns.sync && (
          <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-sync">
            {sync}
          </span>
        )}
        {columns.pr && (
          <span className="flex min-w-0 items-center">
            <PrCell projectId={projectId} branch={realBranch} />
          </span>
        )}
        <span
          className={cn(
            "flex items-center justify-end opacity-0 transition-opacity group-hover/row:opacity-100 group-aria-selected/row:opacity-100 has-[[aria-expanded=true]]:opacity-100",
            // Narrow: over the row's end, on the row's own hover colour, so no column is kept for them.
            columns.narrow && "pointer-events-none absolute inset-y-0 right-0 bg-cf-surface group-hover/row:pointer-events-auto group-aria-selected/row:pointer-events-auto has-[[aria-expanded=true]]:pointer-events-auto",
          )}
          data-testid="worktree-actions"
        >
          <span className={cn("flex h-full items-center", columns.narrow && "bg-cf-control-hover/50 pr-3.5 pl-2")}>
          <RowAction label="New thread here" testId="worktree-new-thread" onClick={() => { composeIn(projectId, path); }}>
            <SquarePen />
          </RowAction>
          <RowAction label="New terminal here" testId="worktree-new-terminal" onClick={() => void newTerminalIn(projectId, path)}>
            <SquareTerminal />
          </RowAction>
          <RowAction label="Show changes" testId="worktree-show-changes" onClick={() => { openChangesTab("current", projectId, path); }}>
            <FileDiff />
          </RowAction>
          {hasActions && <ActionsMenu projectId={projectId} owner={{ kind: "worktree", projectId, path }} from="projects" testId="worktree-actions-menu" />}
          <RowMenu projectId={projectId} path={path} isMain={isMain} branch={realBranch} />
          </span>
        </span>
      </span>
    </NavRow>
  );
}

/**
 * The project's checkouts a thread is on (and main; pageHooks.ts useCheckoutOrder) as a table: Branch (with a "main" or workspace tag) | Threads |
 * Changes | Sync | Pull request | hover actions. Click or Enter opens the checkout's Changes
 * tab in the page's side panel.
 */
export function CheckoutsTable({ projectId, paths, columns }: { projectId: string; paths: readonly string[]; columns: CheckoutColumns }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-cf-surface" data-testid="checkouts-table">
      <div className="grid h-8 items-center gap-x-3 border-b border-cf-divider px-3.5 text-caption text-cf-text-muted" style={{ gridTemplateColumns: gridColumns(columns) }} data-testid="checkouts-head">
        <span>Branch</span>
        <span>Threads</span>
        <span>Changes</span>
        {columns.sync && <span data-testid="checkouts-col-sync">Sync</span>}
        {columns.pr && <span data-testid="checkouts-col-pr">Pull request</span>}
        {!columns.narrow && <span aria-hidden />}
      </div>
      {paths.map((p) => (
        <CheckoutRow key={p} projectId={projectId} path={p} columns={columns} />
      ))}
    </div>
  );
}

