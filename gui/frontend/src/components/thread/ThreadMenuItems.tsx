import { Layers } from "lucide-react";
import { ProjectIcon } from "@/components/icons/ProjectKindIcon";
import { SnoozePresetItems } from "@/components/snooze/SnoozeMenu";
import { beginRename } from "@/keys/bindings";
import { WORKSPACE_FOLDER } from "@/lib/projectSet";
import { canNewLike, canRunElsewhere, worktreeBranch } from "@/lib/threadRow";
import { runCommand, useCommandsStore } from "@/stores/commands";
import { composeLike } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { openSaveWorkspace, useCanSaveAsWorkspace } from "@/stores/saveWorkspace";
import { archiveThread, pinThread, regenerateThreadName, runThreadIn, snoozeThread, threadContext } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { markInPlace, type MenuKit } from "./menuKit";
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
      <ProjectIcon projectId={projectId} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        {branch && <span className="truncate font-mono text-caption">{branch}</span>}
      </span>
      {(current || queued) && <span className="ml-auto pl-3 text-caption">{current ? "runs here" : "queued"}</span>}
    </kit.Item>
  );
}

/**
 * "Run in" for a thread with somewhere else to run (canRunElsewhere): its workspace folder
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
        Run in
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
 * rename that commits one): Rename, Regenerate name (not for a resident thread; disabled while
 * a naming call runs), Pin, Snooze ▸ (and Unsnooze while snoozed); New
 * thread on this branch, Save as workspace, Run in ▸, Restart Claude (while a plugin's
 * environment changed since Claude started: thread.restart), Clear flag(s) (while plugins
 * flagged the thread: thread.flag.clear, every plugin's); Archive. An item a thread cannot
 * use is left out.
 */
export function ThreadMenuItems({ id, kit }: { id: string; kit: MenuKit }) {
  const noProject = useNoProjectThread(id);
  const pinned = useThreadsStore((s) => s.byId[id]?.pinned ?? false);
  // A resident thread (Ember) keeps its name; one naming call at a time.
  const resident = useThreadsStore((s) => (s.byId[id]?.resident ?? "") !== "");
  const naming = useThreadsStore((s) => s.byId[id]?.naming ?? false);
  const archived = useThreadsStore((s) => (s.byId[id]?.archivedAtMs ?? null) !== null);
  const snoozed = useThreadsStore((s) => (s.byId[id]?.snoozedUntilMs ?? null) !== null);
  const stale = useThreadsStore((s) => s.byId[id]?.pluginEnvStale ?? false);
  // Plugin flags hold the thread in the attention group until a plugin or the user clears them.
  const flags = useThreadsStore((s) => s.byId[id]?.flags.length ?? 0);
  // The palette's and the daemon's rules (lib/threadRow): somewhere else to run; a project or workspace to copy.
  const runIn = useThreadsStore((s) => canRunElsewhere(s.byId[id]));
  const newLike = useThreadsStore((s) => canNewLike(s.byId[id])) && !noProject;
  const canSave = useCanSaveAsWorkspace(id) && !noProject;
  const restartListed = useCommandsStore((s) => s.commands.some((c) => c.name === "thread.restart"));
  const clearListed = useCommandsStore((s) => s.commands.some((c) => c.name === "thread.flag.clear"));
  const second = newLike || canSave || runIn || (stale && restartListed) || (flags > 0 && clearListed);
  return (
    <>
      <kit.Item
        data-testid="menu-rename"
        onSelect={() => {
          beginRename(id);
        }}
      >
        Rename
      </kit.Item>
      {!resident && (
        <kit.Item
          data-testid="menu-regenerate-name"
          disabled={naming}
          onSelect={() => {
            markInPlace(kit, id);
            void regenerateThreadName(id);
          }}
        >
          Regenerate name
        </kit.Item>
      )}
      <kit.Item
        data-testid="menu-pin"
        onSelect={() => {
          markInPlace(kit, id);
          void pinThread(id, !pinned);
        }}
      >
        {pinned ? "Unpin" : "Pin"}
      </kit.Item>
      <kit.Sub>
        <kit.SubTrigger data-testid="menu-snooze">
          Snooze
        </kit.SubTrigger>
        <kit.SubContent data-testid="menu-snooze-presets">
          <SnoozePresetItems
            id={id}
            Item={kit.Item}
            Separator={kit.Separator}
            onPreset={() => {
              markInPlace(kit, id);
            }}
          />
        </kit.SubContent>
      </kit.Sub>
      {snoozed && (
        <kit.Item
          data-testid="menu-unsnooze"
          onSelect={() => {
            markInPlace(kit, id);
          void snoozeThread(id, null);
          }}
        >
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
          Save as workspace
        </kit.Item>
      )}
      {runIn && <RunInMenu kit={kit} threadId={id} />}
      {stale && restartListed && (
        <kit.Item
          data-testid="menu-restart"
          onSelect={() => {
            void runCommand("thread.restart", {}, threadContext(id));
          }}
        >
          Restart Claude
        </kit.Item>
      )}
      {flags > 0 && clearListed && (
        <kit.Item
          data-testid="menu-clear-flags"
          onSelect={() => {
            void runCommand("thread.flag.clear", { id }, threadContext(id));
          }}
        >
          {flags === 1 ? "Clear flag" : "Clear flags"}
        </kit.Item>
      )}
      <kit.Separator />
      <kit.Item
        data-testid="menu-archive"
        onSelect={() => {
          markInPlace(kit, id);
          void archiveThread(id, !archived);
        }}
      >
        {archived ? "Unarchive" : "Archive"}
      </kit.Item>
    </>
  );
}
