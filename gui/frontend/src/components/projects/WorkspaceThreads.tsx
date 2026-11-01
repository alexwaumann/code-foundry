import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { ChevronRight } from "lucide-react";
import { RowList } from "@/components/prs/RowList";
import { copyText } from "@/lib/clipboard";
import { NavRow } from "@/lib/NavRow";
import { threadLabel } from "@/lib/prompt";
import { isWorking } from "@/lib/projects";
import { threadBadge, type ThreadBadge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { memberCheckoutPath, memberCheckoutState, workspaceThreadKey } from "@/lib/workspacePage";
import { openChangesTab } from "@/stores/changesPanel";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { revealWorkspace } from "@/stores/workspaceActions";
import { StatusDot, SectionHeader } from "./bits";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { RowAction } from "./RowAction";
import { openThread } from "./workspaceHooks";

const THREAD_ROW_HEIGHT = 44;

/** Branch | Thread | one column per member | the hover actions; each member column at least 8rem (the table scrolls sideways past that). */
function gridColumns(members: number): string {
  return ["minmax(9rem,1.2fr)", "minmax(9rem,1fr)", ...Array.from({ length: members }, () => "minmax(8rem,1fr)"), "3.5rem"].join(" ");
}

const STATUS_WORD: Record<ThreadBadge, string> = { busy: "working", idle: "idle", attention: "needs you", error: "error", unknown: "idle" };
const STATUS_TONE: Record<ThreadBadge, string> = { busy: "text-cf-info-text", idle: "", attention: "text-cf-warning-text", error: "text-cf-error-text", unknown: "" };

async function copyPath(path: string): Promise<void> {
  try {
    await copyText(path);
    toast.success("Path copied", { description: path });
  } catch {
    toast.error("Copy failed");
  }
}

/** One member's checkout state for the thread (lib/workspacePage.ts memberCheckoutState). */
function MemberCell({ threadId, projectId }: { threadId: string; projectId: string }) {
  const path = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t ? memberCheckoutPath(t, projectId) : "";
  });
  const inSet = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && (t.projectId === projectId || t.projectIds.includes(projectId));
  });
  const text = useProjectsStore((s) => {
    const p = s.byId[projectId];
    return memberCheckoutState({ inSet, path, known: p !== undefined, git: p?.git ?? false, worktree: path ? findWorktree(s, projectId, path) : undefined });
  });
  return (
    <span className={cn("truncate text-body-sm", inSet ? "text-cf-text-secondary" : "text-cf-text-muted")} data-testid="thread-member-state" data-project={projectId}>
      {text}
    </span>
  );
}

/** The row's menu: each member's changes, then Finder and the path of the thread's own folder. */
function RowMenu({ threadId, members }: { threadId: string; members: readonly string[] }) {
  // Only what the menu needs, as strings: a thread update that changes none of them does not re-render it.
  const checkouts = useThreadsStore(useShallow((s) => {
    const t = s.byId[threadId];
    return t ? members.map((p) => memberCheckoutPath(t, p)) : [];
  }));
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const names = useProjectsStore(useShallow((s) => members.map((p) => (s.byId[p]?.git ? s.byId[p].name : ""))));
  const items: OverflowItem[] = [];
  members.forEach((p, i) => {
    const path = checkouts[i] ?? "";
    const name = names[i] ?? "";
    if (!path || !name) return;
    items.push({ label: `Show changes in ${name}`, testId: "thread-menu-changes", onSelect: () => { openChangesTab("current", p, path); } });
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

function ThreadRow({ workspaceId, threadId, members, first }: { workspaceId: string; threadId: string; members: readonly string[]; first: boolean }) {
  const branch = useThreadsStore((s) => s.byId[threadId]?.branch ?? "");
  const name = useThreadsStore((s) => threadLabel(s.byId[threadId]?.name ?? "", threadId));
  const badge = useThreadsStore((s) => threadBadge(s.byId[threadId]));
  const live = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && isWorking(t);
  });
  return (
    <NavRow navKey={workspaceThreadKey(workspaceId, threadId)} activateOnClick className={cn("group/row h-full rounded-none border-cf-divider", !first && "border-t")}>
      <span className="grid h-full w-full items-center gap-x-3 px-3.5" style={{ gridTemplateColumns: gridColumns(members.length) }} data-testid="workspace-thread" data-thread={threadId}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot live={live} />
          <span className="min-w-0 truncate text-code" data-testid="thread-branch">
            {branch || "—"}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-body-sm text-cf-text-secondary" data-testid="thread-name-status">
          <span className="min-w-0 truncate">{name}</span>
          <span aria-hidden>·</span>
          <span className={cn("shrink-0", STATUS_TONE[badge])} data-testid="thread-status" data-status={badge}>
            {STATUS_WORD[badge]}
          </span>
        </span>
        {members.map((p) => (
          <MemberCell key={p} threadId={threadId} projectId={p} />
        ))}
        <span className="flex items-center justify-end opacity-0 transition-opacity group-hover/row:opacity-100 group-aria-selected/row:opacity-100 has-[[aria-expanded=true]]:opacity-100" data-testid="thread-actions">
          <RowAction label="Open thread" testId="thread-open" onClick={() => { openThread(threadId); }}>
            <ChevronRight />
          </RowAction>
          <RowMenu threadId={threadId} members={members} />
        </span>
      </span>
    </NavRow>
  );
}

/** Each member's name over its column. */
function MemberHead({ projectId }: { projectId: string }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  return (
    <span className="truncate" data-testid="threads-col-member" data-project={projectId}>
      {name}
    </span>
  );
}

/**
 * The Threads table: Branch | Thread (name · status) | one column per member project with
 * that member's checkout for the thread | hover Open thread and a menu. Click or Enter on a
 * row opens the thread. Archived threads are counted in the caption, not listed.
 */
export function WorkspaceThreads({ workspaceId, members, ids, caption }: { workspaceId: string; members: readonly string[]; ids: readonly string[]; caption: string }) {
  const cols = gridColumns(members.length);
  return (
    <div data-testid="workspace-threads">
      <SectionHeader label="Threads" detail={caption} testId="workspace-threads-title" />
      {ids.length === 0 ? (
        <p className="rounded-lg border bg-cf-surface px-3.5 py-3 text-body-sm text-cf-text-muted" data-testid="workspace-threads-empty">
          No thread is working in this workspace. New thread starts one with every project checked out on one branch.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-cf-surface" data-testid="workspace-threads-table">
          <div className="min-w-fit">
            <div className="grid h-8 items-center gap-x-3 border-b border-cf-divider px-3.5 text-caption text-cf-text-muted" style={{ gridTemplateColumns: cols }} data-testid="threads-head">
              <span>Branch</span>
              <span>Thread</span>
              {members.map((p) => (
                <MemberHead key={p} projectId={p} />
              ))}
              <span aria-hidden />
            </div>
            <RowList
              rows={ids}
              rowKey={(id) => workspaceThreadKey(workspaceId, id)}
              rowHeight={THREAD_ROW_HEIGHT}
              testId="workspace-thread-list"
              render={(id) => <ThreadRow workspaceId={workspaceId} threadId={id} members={members} first={id === ids[0]} />}
            />
          </div>
        </div>
      )}
    </div>
  );
}
