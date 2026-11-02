import { useShallow } from "zustand/react/shallow";
import { FolderRoot, Layers } from "lucide-react";
import { ChecksBadge, PrStateIcon } from "@/components/prs/PrBits";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { threadLabel } from "@/lib/prompt";
import { changesCell, checkoutColumns, checkoutHasChanges, checkoutThreads, projectWorktreeKey, syncCell, threadOnCheckout, threadsCell, type CheckoutColumns } from "@/lib/projects";
import { threadBadge } from "@/lib/thread";
import { worktreeBranch } from "@/lib/threadRow";
import { useWidth } from "@/lib/useWidth";
import { useActionsStore } from "@/stores/actions";
import { branchKey, branchPullRequestsResource } from "@/stores/gh";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Pill, StatusDot, type PillTone } from "./bits";
import { CHECKOUT_MENU_PARTS } from "./CheckoutMenuParts";
import { checkoutMenu, type CheckoutMenuThread } from "./menus";
import { RowContextMenu } from "./RowContextMenu";

/** A table column: its header, grid track and test id. */
interface Column {
  label: string;
  track: string;
  testId: string;
}

/** Branch takes the room; the others fit their longest usual text ("1 working · 1 idle", "2 to push · 1 behind", a pill with checks). */
function tableColumns(c: CheckoutColumns): Column[] {
  return [
    { label: "Branch", track: "minmax(0,1fr)", testId: "checkouts-col-branch" },
    c.threads && { label: "Threads", track: "9.5rem", testId: "checkouts-col-threads" },
    c.changes && { label: "Changes", track: "6.5rem", testId: "checkouts-col-changes" },
    c.sync && { label: "Sync", track: "7rem", testId: "checkouts-col-sync" },
    c.pr && { label: "Pull request", track: "7.5rem", testId: "checkouts-col-pr" },
  ].filter((x): x is Column => x !== false);
}

/** Open pull requests read green, drafts neutral, merged blue, closed red (the pill's tint). */
function prTone(state: string, draft: boolean): PillTone {
  if (state === "merged") return "info";
  if (state === "closed") return "error";
  return draft ? "neutral" : "success";
}

/** The viewer's pull request on the branch (watched while shown; not on GitHub, nothing), or null. */
function useBranchPr(projectId: string, branch: string, github: boolean) {
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const isDefault = useProjectsStore((s) => s.byId[projectId]?.defaultBranch === branch);
  const entry = useResource(branchPullRequestsResource, github && slug && branch && !isDefault ? branchKey(slug, branch) : null);
  const pr = entry?.data?.pullRequests[0] ?? null;
  return pr ? { ...pr, repoSlug: pr.repoSlug || slug } : null;
}

function PrCell({ pr }: { pr: ReturnType<typeof useBranchPr> }) {
  if (!pr) return <span className="text-body-sm text-cf-text-muted">—</span>;
  return (
    <Tip label={`#${String(pr.number)} ${pr.title}`}>
      <button
        type="button"
        tabIndex={-1}
        className="flex w-fit"
        data-testid="worktree-pr"
        data-state={pr.state}
        onClick={() => {
          openPullRequestInPanel({ slug: pr.repoSlug, number: pr.number });
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

const SIGNAL = "size-3.5 shrink-0 text-cf-text-muted";

/** The main checkout's signal: the project's own folder. */
function MainSignal({ path }: { path: string }) {
  return (
    <Tip
      className="max-w-[32rem]"
      label={
        <>
          <span className="font-medium">Main checkout</span>
          <span className="text-cf-text-muted"> · the project folder, {tildify(path)}</span>
        </>
      }
    >
      <FolderRoot className={SIGNAL} aria-label="Main checkout" data-testid="worktree-main-signal" />
    </Tip>
  );
}

/** A workspace checkout's signal; its card names the workspace, its projects and the threads on the checkout from it. */
function WorkspaceSignal({ workspaceId, path }: { workspaceId: string; path: string }) {
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? "");
  const memberIds = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => m.projectId)));
  const members = useProjectsStore(useShallow((s) => memberIds.map((p) => s.byId[p]?.name ?? p)));
  const threads = useThreadsStore(
    useShallow((s) =>
      s.order.flatMap((id) => {
        const t = s.byId[id];
        return t && t.archivedAtMs === null && t.workspaceId === workspaceId && threadOnCheckout(t, path) ? [threadLabel(t.name, t.id)] : [];
      }),
    ),
  );
  if (!name) return null;
  return (
    <Tip
      className="w-[260px]"
      label={
        <span className="flex flex-col gap-0.5" data-testid="worktree-workspace-card">
          <span className="flex items-center gap-1.5 font-medium">
            <Layers className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{name}</span>
          </span>
          <span className="text-cf-text-muted">Workspace · {members.join(", ")}</span>
          {threads.length > 0 && (
            <span className="text-cf-text-muted">
              {threads.length === 1 ? "1 thread" : `${String(threads.length)} threads`} · {threads.join(", ")}
            </span>
          )}
        </span>
      }
    >
      <Layers className={SIGNAL} aria-label={`Workspace ${name}`} data-testid="worktree-workspace-signal" data-workspace={workspaceId} />
    </Tip>
  );
}

/** The checkout's open threads for its menu, in the store's order, read when the menu opens. */
function menuThreads(path: string): CheckoutMenuThread[] {
  const s = useThreadsStore.getState();
  return s.order.flatMap((id) => {
    const t = s.byId[id];
    return t && t.archivedAtMs === null && threadOnCheckout(t, path) ? [{ id, name: threadLabel(t.name, id), badge: threadBadge(t) }] : [];
  });
}

function CheckoutRow({ projectId, path, columns, template }: { projectId: string; path: string; columns: CheckoutColumns; template: string }) {
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
  const { working, idle, workspaceId } = useThreadsStore(
    useShallow((s) => {
      const t = checkoutThreads(s, path);
      return { working: t.working, idle: t.idle, workspaceId: t.workspaceId };
    }),
  );
  const pr = useBranchPr(projectId, realBranch, columns.pr);
  const items = () => {
    const st = findWorktree(useProjectsStore.getState(), projectId, path)?.status;
    return checkoutMenu({
      projectId,
      path,
      branch: realBranch,
      isMain,
      threads: menuThreads(path),
      changed: st ? checkoutHasChanges(st) : false,
      pr: pr ? { slug: pr.repoSlug, number: pr.number } : null,
      actions: (useActionsStore.getState().byProject[projectId]?.length ?? 0) > 0,
    });
  };
  return (
    <RowContextMenu navKey={projectWorktreeKey(projectId, path)} testId="checkout-menu" items={items} parts={CHECKOUT_MENU_PARTS}>
      <NavRow navKey={projectWorktreeKey(projectId, path)} passive className="h-9 rounded-md">
        <span className="grid h-full items-center gap-3 px-2 text-body" style={{ gridTemplateColumns: template }} data-testid="project-worktree" data-path={path} data-main={isMain || undefined}>
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot live={working > 0} />
            <Tip label={tildify(path)} align="start">
              <span className="min-w-0 truncate text-code" data-testid="worktree-branch">
                {branch}
              </span>
            </Tip>
            {isMain && <MainSignal path={path} />}
            {workspaceId && <WorkspaceSignal workspaceId={workspaceId} path={path} />}
          </span>
          {columns.threads && (
            <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-threads">
              {threadsCell(working, idle)}
            </span>
          )}
          {columns.changes && (
            <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-changes-cell">
              {changes}
            </span>
          )}
          {columns.sync && (
            <span className="truncate text-body-sm text-cf-text-secondary" data-testid="worktree-sync">
              {sync}
            </span>
          )}
          {columns.pr && (
            <span className="flex min-w-0 items-center">
              <PrCell pr={pr} />
            </span>
          )}
        </span>
      </NavRow>
    </RowContextMenu>
  );
}

/**
 * The project's checkouts a thread is on (and main; pageHooks.ts useCheckoutOrder), in the
 * Projects index's table grammar: Branch (a FolderRoot on main, Layers on a workspace's
 * checkout) | Threads | Changes | Sync (with a remote) | Pull request (on GitHub). The columns
 * drop by the table's own width (lib/projects.ts checkoutColumns). A row has no click and no
 * hover tint: its right-click menu (menus.ts checkoutMenu) holds what it does, the keyboard's
 * ContextMenu key or Shift+F10 opens it on the cursor's row. docs/notes/project-page-2-checkouts.md.
 */
export function CheckoutsTable({ projectId, paths, remote, github }: { projectId: string; paths: readonly string[]; remote: boolean; github: boolean }) {
  const [ref, width] = useWidth(1100);
  const columns = checkoutColumns(width, { remote, github });
  const cols = tableColumns(columns);
  const template = cols.map((c) => c.track).join(" ");
  return (
    <div ref={ref} className="rounded-lg border" data-testid="checkouts-table" data-columns={cols.map((c) => c.label).join(",")}>
      <div className="grid gap-3 border-b px-2 py-1 text-overline" style={{ gridTemplateColumns: template }} data-testid="checkouts-head">
        {cols.map((c) => (
          <span key={c.label} className="truncate" data-testid={c.testId}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="p-0.5">
        {paths.map((p) => (
          <CheckoutRow key={p} projectId={projectId} path={p} columns={columns} template={template} />
        ))}
      </div>
    </div>
  );
}
