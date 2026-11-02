import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";
import { RowList } from "@/components/prs/RowList";
import { copyText } from "@/lib/clipboard";
import { NavRow } from "@/lib/NavRow";
import { threadLabel } from "@/lib/prompt";
import { isWorking } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { changedCheckouts, memberCheckoutPath, threadChangesCell, workspaceThreadKey } from "@/lib/workspacePage";
import { openChangesTab } from "@/stores/changesPanel";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { findWorktree, useProjectsStore, type ProjectsData } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { revealWorkspace } from "@/stores/workspaceActions";
import { StatusDot, SectionHeader } from "./bits";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { RowAction } from "./RowAction";
import { openThread } from "./workspaceHooks";

const THREAD_ROW_HEIGHT = 36;

/** Branch takes the room, Thread the next most, Changes fits "12 files · 3 commits", then the hover actions. */
const TEMPLATE = "minmax(9rem,1.4fr) minmax(8rem,1fr) 9rem 3.5rem";

async function copyPath(path: string): Promise<void> {
  try {
    await copyText(path);
    toast.success("Path copied", { description: path });
  } catch {
    toast.error("Copy failed");
  }
}

/** A thread's member checkouts as the projects slice has them (a member not in its set, or not made yet, has none). */
function memberCheckouts(s: ProjectsData, paths: readonly string[], members: readonly string[]) {
  return members.flatMap((projectId, i) => {
    const path = paths[i] ?? "";
    const wt = path ? findWorktree(s, projectId, path) : undefined;
    return wt ? [{ projectId, path, status: wt.status }] : [];
  });
}

/** The thread's member checkouts' paths, in the members' order ("" for none), as one stable list. */
function useCheckoutPaths(threadId: string, members: readonly string[]): string[] {
  return useThreadsStore(
    useShallow((s) => {
      const t = s.byId[threadId];
      return t ? members.map((p) => memberCheckoutPath(t, p)) : [];
    }),
  );
}

/** The row's Changes cell: its member checkouts' changes summed (lib/workspacePage.ts threadChangesCell). */
function ChangesCell({ threadId, members }: { threadId: string; members: readonly string[] }) {
  const paths = useCheckoutPaths(threadId, members);
  const text = useProjectsStore((s) => threadChangesCell(memberCheckouts(s, paths, members).map((c) => c.status)));
  const quiet = text === "" || text === "clean";
  return (
    <span className={cn("truncate text-body-sm", quiet ? "text-cf-text-muted" : "text-cf-text-secondary")} data-testid="thread-changes" data-clean={text === "clean" || undefined}>
      {text || "—"}
    </span>
  );
}

/**
 * The row's menu: Show changes in <project> for each member whose checkout is not clean, then
 * Open in Finder and Copy path for the thread's own folder. Built when it opens (the
 * statuses are read then).
 */
function RowMenu({ threadId, members }: { threadId: string; members: readonly string[] }) {
  const paths = useCheckoutPaths(threadId, members);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  // Only what the menu shows, as strings: a status change that does not change it does not re-render the row.
  const changed = useProjectsStore(
    useShallow((s) =>
      changedCheckouts(memberCheckouts(s, paths, members))
        .filter((c) => s.byId[c.projectId]?.git)
        .map((c) => `${c.projectId}\u0001${c.path}\u0001${s.byId[c.projectId]?.name ?? c.projectId}`),
    ),
  );
  const items: OverflowItem[] = changed.map((key) => {
    const [projectId = "", path = "", name = ""] = key.split("\u0001");
    return { label: `Show changes in ${name}`, testId: "thread-menu-changes", onSelect: () => { openChangesTab("current", projectId, path); } };
  });
  if (items.length > 0) items.push("separator");
  items.push(
    {
      label: "Open in Finder",
      testId: "thread-menu-reveal",
      // The thread's own folder: its primary's checkout, else the workspace's folder.
      onSelect: () => {
        if (primary) void runCommand("worktree.reveal", { worktree: cwd }, worktreeContext(primary, cwd));
        else if (workspaceId) void revealWorkspace(workspaceId);
      },
    },
    { label: "Copy path", testId: "thread-menu-copy-path", disabled: !cwd, onSelect: () => void copyPath(cwd) },
  );
  return <OverflowMenu label="More actions" testId="thread-more" items={items} />;
}

function ThreadRow({ workspaceId, threadId, members }: { workspaceId: string; threadId: string; members: readonly string[] }) {
  const branch = useThreadsStore((s) => s.byId[threadId]?.branch ?? "");
  const name = useThreadsStore((s) => threadLabel(s.byId[threadId]?.name ?? "", threadId));
  const live = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && isWorking(t);
  });
  return (
    <NavRow navKey={workspaceThreadKey(workspaceId, threadId)} activateOnClick className="group/row h-full rounded-md">
      <span className="grid h-full items-center gap-3 px-2 text-body" style={{ gridTemplateColumns: TEMPLATE }} data-testid="workspace-thread" data-thread={threadId}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot live={live} />
          <span className="min-w-0 truncate text-code" data-testid="thread-branch">
            {branch || "—"}
          </span>
        </span>
        <span className="min-w-0 truncate text-body-sm text-cf-text-secondary" data-testid="thread-name">
          {name}
        </span>
        <ChangesCell threadId={threadId} members={members} />
        <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-aria-selected/row:opacity-100 has-[[aria-expanded=true]]:opacity-100" data-testid="thread-actions">
          <RowAction label="Open thread" testId="thread-open" onClick={() => { openThread(threadId); }}>
            <ChevronRight />
          </RowAction>
          <RowMenu threadId={threadId} members={members} />
        </span>
      </span>
    </NavRow>
  );
}

/**
 * The Threads table, in the Projects index's table grammar: Branch (the status dot, live while
 * it works) | Thread (its name) | Changes (over every member's checkout) | hover Open thread
 * and a menu. Click or Enter on a row opens the thread. Archived threads are counted in the
 * caption, not listed. docs/notes/workspace-page-polish.md.
 */
export function WorkspaceThreads({ workspaceId, members, ids, caption }: { workspaceId: string; members: readonly string[]; ids: readonly string[]; caption: string }) {
  return (
    <div data-testid="workspace-threads">
      <SectionHeader label="Threads" detail={caption} testId="workspace-threads-title" />
      {ids.length === 0 ? (
        <p className="rounded-lg border bg-cf-surface px-3.5 py-3 text-body-sm text-cf-text-muted" data-testid="workspace-threads-empty">
          No thread is working in this workspace. New thread starts one with every project checked out on one branch.
        </p>
      ) : (
        <div className="rounded-lg border" data-testid="workspace-threads-table">
          <div className="grid gap-3 border-b px-2 py-1 text-overline" style={{ gridTemplateColumns: TEMPLATE }} data-testid="threads-head">
            <span className="truncate">Branch</span>
            <span className="truncate">Thread</span>
            <span className="truncate">Changes</span>
            <span aria-hidden />
          </div>
          <div className="p-0.5">
            <RowList
              rows={ids}
              rowKey={(id) => workspaceThreadKey(workspaceId, id)}
              rowHeight={THREAD_ROW_HEIGHT}
              testId="workspace-thread-list"
              render={(id) => <ThreadRow workspaceId={workspaceId} threadId={id} members={members} />}
            />
          </div>
        </div>
      )}
    </div>
  );
}
