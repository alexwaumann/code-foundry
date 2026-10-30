import { AlarmClock, AlarmClockOff, Archive, ArchiveRestore, ArrowRightLeft, Eye, EyeOff, FolderGit2, GitBranchPlus, Layers, Pencil, Pin, PinOff, RotateCw } from "lucide-react";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { beginRename } from "@/keys/bindings";
import { WORKSPACE_FOLDER } from "@/lib/projectSet";
import { canNewLike, canRunElsewhere, worktreeBranch } from "@/lib/threadRow";
import { runCommand, useCommandsStore } from "@/stores/commands";
import { composeLike } from "@/stores/compose";
import { useSidebarShown } from "@/stores/lineage";
import { useProjectsStore } from "@/stores/projects";
import { openSaveWorkspace, useCanSaveAsWorkspace } from "@/stores/saveWorkspace";
import { archiveThread, pinThread, runThreadIn, setThreadSidebar, snoozeThread, threadContext, THREAD_COMMANDS } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { MenuKit } from "./menuKit";
import { useNoProjectThread } from "./useNoProject";
import { useThreadCheckouts } from "./useThreadCheckouts";

function MemberItem({ kit, threadId, projectId, path, current, queued }: { kit: MenuKit; threadId: string; projectId: string; path: string; current: boolean; queued: boolean }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => (path ? worktreeBranch(s, projectId, path) : ""));
  return (
    <kit.Item
      disabled={current}
      data-member={projectId}
      onSelect={() => {
        void runThreadIn(threadId, projectId);
      }}
    >
      <FolderGit2 className="text-cf-info-text/90" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {branch && <span className="truncate font-mono text-caption">{branch}</span>}
      </span>
      {(current || queued) && <span className="ml-auto pl-3 text-caption">{current ? "runs here" : "queued"}</span>}
    </kit.Item>
  );
}

/**
 * "Run in…" for a thread with somewhere else to run (canRunElsewhere): its workspace folder
 * and its projects' checkouts, the current one disabled. Picking one invokes
 * thread.run-in; the row shows the queued move until it happens.
 */
function RunInMenu({ kit, threadId }: { kit: MenuKit; threadId: string }) {
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const pending = useThreadsStore((s) => s.byId[threadId]?.pendingWorktreePath ?? "");
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const wsName = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? workspaceId) : ""));
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const sorted = [...projectIds].sort();
  return (
    <kit.Sub>
      <kit.SubTrigger data-testid="menu-run-in">
        <ArrowRightLeft />
        Run in…
      </kit.SubTrigger>
      <kit.SubContent data-testid="menu-run-in-members">
        {workspaceId && (
          <kit.Item
            disabled={primary === ""}
            data-member="workspace"
            onSelect={() => {
              void runThreadIn(threadId, "workspace");
            }}
          >
            <Layers className="text-cf-highlight-text" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{WORKSPACE_FOLDER}</span>
              <span className="truncate text-caption">{wsName}</span>
            </span>
            {primary === "" && <span className="ml-auto pl-3 text-caption">runs here</span>}
          </kit.Item>
        )}
        {workspaceId && sorted.length > 0 && <kit.Label>Projects</kit.Label>}
        {sorted.map((projectId) => {
          const path = paths[projectId] ?? "";
          return <MemberItem key={projectId} kit={kit} threadId={threadId} projectId={projectId} path={path} current={projectId === primary} queued={path !== "" && path === pending && path !== cwd} />;
        })}
      </kit.SubContent>
    </kit.Sub>
  );
}

/**
 * A thread's menu items, one list for the sidebar row's context menu (RowMenu) and the
 * thread header's title menu (ThreadTitleMenu), each item a registry command (or the inline
 * rename that commits one): Rename, Pin, Snooze ▸ (and Unsnooze while snoozed); New
 * thread on this branch, Save as workspace, Run in ▸, Hide or Show in sidebar (a thread
 * another created, while thread.sidebar is listed), Restart Claude (while a plugin's
 * environment changed since Claude started: thread.restart); Archive. An item a thread
 * cannot use is left out.
 */
export function ThreadMenuItems({ id, kit }: { id: string; kit: MenuKit }) {
  const noProject = useNoProjectThread(id);
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  const archived = useThreadsStore((s) => (s.byId[id]?.archivedAtMs ?? null) !== null);
  const snoozed = useThreadsStore((s) => (s.byId[id]?.snoozedUntilMs ?? null) !== null);
  const stale = useThreadsStore((s) => s.byId[id]?.pluginEnvStale ?? false);
  // The palette's and the daemon's rules (lib/threadRow): somewhere else to run; a project or workspace to copy.
  const runIn = useThreadsStore((s) => canRunElsewhere(s.byId[id]));
  const newLike = useThreadsStore((s) => canNewLike(s.byId[id])) && !noProject;
  const canSave = useCanSaveAsWorkspace(id) && !noProject;
  // Another thread created it: shown (the rule, lib/inSidebar.ts) it can be handed back, hidden it can be shown.
  const shown = useSidebarShown(id);
  const sidebarListed = useCommandsStore((s) => s.commands.some((c) => c.name === THREAD_COMMANDS.sidebar));
  const restartListed = useCommandsStore((s) => s.commands.some((c) => c.name === "thread.restart"));
  const second = newLike || canSave || runIn || (shown !== null && sidebarListed) || (stale && restartListed);
  return (
    <>
      <kit.Item
        data-testid="menu-rename"
        onSelect={() => {
          beginRename(id);
        }}
      >
        <Pencil />
        Rename
      </kit.Item>
      <kit.Item
        data-testid="menu-pin"
        onSelect={() => {
          void pinThread(id, !pinned);
        }}
      >
        {pinned ? <PinOff /> : <Pin />}
        {pinned ? "Unpin" : "Pin"}
      </kit.Item>
      <kit.Sub>
        <kit.SubTrigger data-testid="menu-snooze">
          <AlarmClock />
          Snooze
        </kit.SubTrigger>
        <kit.SubContent data-testid="menu-snooze-presets">
          <SnoozePresetItems id={id} Item={kit.Item} Separator={kit.Separator} />
        </kit.SubContent>
      </kit.Sub>
      {snoozed && (
        <kit.Item
          data-testid="menu-unsnooze"
          onSelect={() => {
            void snoozeThread(id, null);
          }}
        >
          <AlarmClockOff />
          Unsnooze
        </kit.Item>
      )}
      {second && <kit.Separator />}
      {newLike && (
        <kit.Item
          data-testid="menu-new-like"
          onSelect={() => {
            composeLike(id);
          }}
        >
          <GitBranchPlus />
          New thread on this branch
        </kit.Item>
      )}
      {canSave && (
        <kit.Item
          data-testid="menu-save-workspace"
          onSelect={() => {
            openSaveWorkspace(id);
          }}
        >
          <Layers />
          Save as workspace
        </kit.Item>
      )}
      {runIn && <RunInMenu kit={kit} threadId={id} />}
      {shown !== null && sidebarListed && (
        <kit.Item
          data-testid={shown ? "menu-sidebar-hide" : "menu-sidebar-show"}
          onSelect={() => {
            void setThreadSidebar(id, !shown);
          }}
        >
          {shown ? <EyeOff /> : <Eye />}
          {shown ? "Hide from sidebar" : "Show in sidebar"}
        </kit.Item>
      )}
      {stale && restartListed && (
        <kit.Item
          data-testid="menu-restart"
          onSelect={() => {
            void runCommand("thread.restart", {}, threadContext(id));
          }}
        >
          <RotateCw />
          Restart Claude
        </kit.Item>
      )}
      <kit.Separator />
      <kit.Item
        data-testid="menu-archive"
        onSelect={() => {
          void archiveThread(id, !archived);
        }}
      >
        {archived ? <ArchiveRestore /> : <Archive />}
        {archived ? "Unarchive" : "Archive"}
      </kit.Item>
    </>
  );
}
