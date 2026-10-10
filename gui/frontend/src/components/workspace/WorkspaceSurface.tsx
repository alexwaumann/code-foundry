import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { GitBranch, Layers } from "lucide-react";
import { WorkspaceMembers } from "@/components/projects/WorkspaceMembers";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { memberKey } from "@/lib/projects";
import { SESSION_LABEL } from "@/lib/tree";
import { useCurrentPanelKey } from "@/stores/panel";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUiStore } from "@/stores/ui";
import { openMemberTab } from "@/stores/workspacePanel";
import { useWorkspacesStore } from "@/stores/workspaces";

const SEP = "\u0000";

/**
 * The thread this panel belongs to, when it is one of the workspace's threads: the
 * selected session, or the thread of the selected terminal. "" otherwise. (A panel always
 * shows the current selection's panel, so the selection is the panel's owner.)
 */
function useThreadOf(workspaceId: string): string {
  const sel = useUiStore((s) => s.selection);
  const termThread = useTerminalsStore((s) => (sel.kind === "terminal" ? (s.byId[sel.id]?.labels[SESSION_LABEL] ?? "") : ""));
  const id = sel.kind === "session" ? sel.id : termThread;
  const owned = useSessionsStore((s) => id !== "" && s.byId[id]?.workspaceId === workspaceId);
  return owned ? id : "";
}

function Header({ workspaceId }: { workspaceId: string }) {
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  const branch = useWorkspacesStore((s) => s.byId[workspaceId]?.branch ?? "");
  const count = useWorkspacesStore((s) => s.byId[workspaceId]?.members.length ?? 0);
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="workspace-surface-header">
      <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
        <Layers className="size-4 shrink-0 text-violet-400/90" aria-hidden />
        <span className="min-w-0 truncate" data-testid="workspace-surface-name">
          {name}
        </span>
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums" data-testid="workspace-surface-count">
          {count} {count === 1 ? "member" : "members"}
        </span>
      </h2>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate font-mono" data-testid="workspace-surface-branch">
          {branch}
        </span>
      </span>
    </header>
  );
}

/**
 * The side panel's workspace surface: the workspace's name, branch and members (the
 * shared WorkspaceMembers list in its panel layout), the thread's current member marked,
 * Run in on the others, add and remove members. A member opens as a worktree tab of this
 * panel (its button, Enter, or a double-click).
 */
export function WorkspaceSurface({ workspaceId }: { workspaceId: string }) {
  const panelKey = useCurrentPanelKey();
  const threadId = useThreadOf(workspaceId);
  const known = useWorkspacesStore((s) => s.byId[workspaceId] !== undefined);
  const loaded = useWorkspacesStore((s) => s.loaded);
  const memberKeys = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.repoId}${SEP}${m.worktreePath}`)));
  const items = useMemo<NavItem[]>(
    () =>
      memberKeys.map((k) => {
        const [repoId = "", path = ""] = k.split(SEP);
        return {
          key: memberKey(workspaceId, repoId),
          activate: () => {
            if (panelKey) openMemberTab(panelKey, repoId, path);
          },
        };
      }),
    [memberKeys, workspaceId, panelKey],
  );
  const nav = useNav(items);
  const open = (repoId: string, path: string) => {
    if (panelKey) openMemberTab(panelKey, repoId, path);
  };

  return (
    // @container: the header and rows adapt to the panel's width (down to 280px).
    <div className="@container flex min-w-0 flex-col" data-testid="workspace-surface" data-workspace={workspaceId} data-thread={threadId || undefined}>
      {!known ? (
        <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="workspace-surface-missing">
          {loaded ? "This workspace no longer exists." : "Loading workspace…"}
        </p>
      ) : (
        <>
          <Header workspaceId={workspaceId} />
          <NavProvider value={nav.ctx}>
            <div
              tabIndex={0}
              role="listbox"
              aria-label="Workspace members"
              aria-activedescendant={nav.activeDescendant}
              className="px-2 py-2 outline-none"
              data-testid="workspace-surface-list"
              onKeyDown={nav.onKeyDown}
            >
              <WorkspaceMembers workspaceId={workspaceId} layout="panel" threadId={threadId || undefined} onOpen={open} />
            </div>
          </NavProvider>
        </>
      )}
    </div>
  );
}
