import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { ChevronRight, Layers } from "lucide-react";
import { ProjectIcon } from "@/components/icons/ProjectKindIcon";
import { RowList } from "@/components/prs/RowList";
import { copyText } from "@/lib/clipboard";
import { NavRow } from "@/lib/NavRow";
import { threadLabel } from "@/lib/prompt";
import { isWorking } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { useWidth } from "@/lib/useWidth";
import { changedCheckouts, memberCheckoutPath, threadChangesCell, threadPlace, workspaceThreadKey, type ThreadPlace } from "@/lib/workspacePage";
import { openChangesTab } from "@/stores/changesPanel";
import { findWorktree, useProjectsStore, type ProjectsData } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { StatusDot, SectionHeader } from "./bits";
import { checkoutOpenIn, workspaceOpenIn } from "./openIn";
import { OpenInSplitItem } from "./OpenInMenuItem";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { RowAction } from "./RowAction";
import type { RowMenuEntry, RowMenuParts } from "./rowMenu";
import { openThread, useWorkspaceTerminal } from "./workspaceHooks";

const THREAD_ROW_HEIGHT = 36;

/**
 * Branch takes the room, Thread the next most, Runs in a project name (or "workspace
 * folder"), Changes fits "12 files · 3 commits", then the hover actions. Below
 * RUNS_IN_BELOW px of table Runs in drops (the row menu's Open in still goes there).
 */
const TEMPLATE = "minmax(9rem,1.4fr) minmax(8rem,1fr) minmax(8rem,11rem) 9rem 3.5rem";
const TEMPLATE_NARROW = "minmax(9rem,1.4fr) minmax(8rem,1fr) 9rem 3.5rem";
const RUNS_IN_BELOW = 720;

/** The thread's place (lib/workspacePage.ts threadPlace) as one string, so the row re-renders only when it moves. */
function useThreadPlace(threadId: string): ThreadPlace | null {
  const key = useThreadsStore((s) => {
    const t = s.byId[threadId];
    const p = t ? threadPlace(t) : null;
    if (!p) return "";
    return p.kind === "checkout" ? `checkout\u0001${p.projectId}\u0001${p.path}` : `folder\u0001${p.workspaceId}`;
  });
  const [kind = "", a = "", b = ""] = key.split("\u0001");
  if (kind === "checkout") return { kind, projectId: a, path: b };
  if (kind === "folder") return { kind, workspaceId: a };
  return null;
}

/** Runs in: the primary project (its kind icon and name), or "workspace folder" with the layers. */
function RunsInCell({ threadId }: { threadId: string }) {
  const place = useThreadPlace(threadId);
  const projectId = place?.kind === "checkout" ? place.projectId : "";
  const name = useProjectsStore((s) => (projectId ? (s.byId[projectId]?.name ?? projectId) : ""));
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-body-sm text-cf-text-secondary" data-testid="thread-runs-in" data-kind={place?.kind}>
      {place === null ? (
        <span className="text-cf-text-muted">—</span>
      ) : (
        <>
          {place.kind === "checkout" ? <ProjectIcon projectId={projectId} className="size-3.5 shrink-0 text-cf-text-muted" /> : <Layers className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />}
          <span className="min-w-0 truncate">{place.kind === "checkout" ? name : "workspace folder"}</span>
        </>
      )}
    </span>
  );
}

/** The row menu's split Open in Finder (OpenInMenuItem.tsx), aimed where the thread runs. */
interface ThreadOpenInPart {
  kind: "thread-open-in";
  testId: string;
  place: ThreadPlace;
  /** A folder place's Open in list has Terminal (the workspace's New terminal has a place). */
  terminal: boolean;
}

function ThreadOpenIn({ entry }: { entry: ThreadOpenInPart }) {
  const target = entry.place.kind === "checkout" ? checkoutOpenIn(entry.place.projectId, entry.place.path) : workspaceOpenIn(entry.place.workspaceId, entry.terminal);
  return <OpenInSplitItem target={target} testId={entry.testId} menu="dropdown" />;
}

const THREAD_MENU_PARTS: RowMenuParts<ThreadOpenInPart> = { "thread-open-in": ThreadOpenIn };

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
 * Open in Finder (a split item: its › lists Finder, the editors and Terminal) and Copy path,
 * both for where the thread runs (the Runs in column).
 */
function RowMenu({ workspaceId, threadId, members }: { workspaceId: string; threadId: string; members: readonly string[] }) {
  const paths = useCheckoutPaths(threadId, members);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const place = useThreadPlace(threadId);
  const terminal = useWorkspaceTerminal(workspaceId);
  // Only what the menu shows, as strings: a status change that does not change it does not re-render the row.
  const changed = useProjectsStore(
    useShallow((s) =>
      changedCheckouts(memberCheckouts(s, paths, members))
        .filter((c) => s.byId[c.projectId]?.git)
        .map((c) => `${c.projectId}\u0001${c.path}\u0001${s.byId[c.projectId]?.name ?? c.projectId}`),
    ),
  );
  const items: RowMenuEntry<ThreadOpenInPart>[] = changed.map((key): OverflowItem => {
    const [projectId = "", path = "", name = ""] = key.split("\u0001");
    return { label: `Show changes in ${name}`, testId: "thread-menu-changes", onSelect: () => { openChangesTab("current", projectId, path); } };
  });
  if (items.length > 0) items.push("separator");
  if (place) items.push({ kind: "thread-open-in", testId: "thread-menu-reveal", place, terminal });
  items.push({ label: "Copy path", testId: "thread-menu-copy-path", disabled: !cwd, onSelect: () => void copyPath(cwd) });
  return <OverflowMenu label="More actions" testId="thread-more" items={items} parts={THREAD_MENU_PARTS} />;
}

function ThreadRow({ workspaceId, threadId, members, runsIn }: { workspaceId: string; threadId: string; members: readonly string[]; runsIn: boolean }) {
  const branch = useThreadsStore((s) => s.byId[threadId]?.branch ?? "");
  const name = useThreadsStore((s) => threadLabel(s.byId[threadId]?.name ?? "", threadId));
  const live = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t !== undefined && isWorking(t);
  });
  return (
    <NavRow navKey={workspaceThreadKey(workspaceId, threadId)} activateOnClick className="group/row h-full rounded-md">
      <span className="grid h-full items-center gap-3 px-2 text-body" style={{ gridTemplateColumns: runsIn ? TEMPLATE : TEMPLATE_NARROW }} data-testid="workspace-thread" data-thread={threadId}>
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot live={live} />
          <span className="min-w-0 truncate text-code" data-testid="thread-branch">
            {branch || "—"}
          </span>
        </span>
        <span className="min-w-0 truncate text-body-sm text-cf-text-secondary" data-testid="thread-name">
          {name}
        </span>
        {runsIn && <RunsInCell threadId={threadId} />}
        <ChangesCell threadId={threadId} members={members} />
        <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover/row:opacity-100 group-aria-selected/row:opacity-100 has-[[aria-expanded=true]]:opacity-100" data-testid="thread-actions">
          <RowAction label="Open thread" testId="thread-open" onClick={() => { openThread(threadId); }}>
            <ChevronRight />
          </RowAction>
          <RowMenu workspaceId={workspaceId} threadId={threadId} members={members} />
        </span>
      </span>
    </NavRow>
  );
}

/**
 * The Threads table, in the Projects index's table grammar: Branch (the status dot, live while
 * it works) | Thread (its name) | Runs in (its primary project or the workspace folder; drops
 * on a narrow table) | Changes (over every member's checkout) | hover Open thread and a menu. Click or Enter on a row opens the thread. Archived threads are counted in the
 * caption, not listed. docs/notes/workspace-page-polish.md.
 */
export function WorkspaceThreads({ workspaceId, members, ids, caption }: { workspaceId: string; members: readonly string[]; ids: readonly string[]; caption: string }) {
  const [ref, width] = useWidth(1100);
  const runsIn = width >= RUNS_IN_BELOW;
  return (
    <div data-testid="workspace-threads">
      <SectionHeader label="Threads" detail={caption} testId="workspace-threads-title" />
      {ids.length === 0 ? (
        <p className="rounded-lg border bg-cf-surface px-3.5 py-3 text-body-sm text-cf-text-muted" data-testid="workspace-threads-empty">
          No thread is working in this workspace. New thread starts one with every project checked out on one branch.
        </p>
      ) : (
        <div ref={ref} className="rounded-lg border" data-testid="workspace-threads-table" data-runs-in={runsIn || undefined}>
          <div className="grid gap-3 border-b px-2 py-1 text-overline" style={{ gridTemplateColumns: runsIn ? TEMPLATE : TEMPLATE_NARROW }} data-testid="threads-head">
            <span className="truncate">Branch</span>
            <span className="truncate">Thread</span>
            {runsIn && <span className="truncate">Runs in</span>}
            <span className="truncate">Changes</span>
            <span aria-hidden />
          </div>
          <div className="p-0.5">
            <RowList
              rows={ids}
              rowKey={(id) => workspaceThreadKey(workspaceId, id)}
              rowHeight={THREAD_ROW_HEIGHT}
              testId="workspace-thread-list"
              render={(id) => <ThreadRow workspaceId={workspaceId} threadId={id} members={members} runsIn={runsIn} />}
            />
          </div>
        </div>
      )}
    </div>
  );
}
