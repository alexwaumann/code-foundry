import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRightLeft, FolderGit2, PanelRightOpen, Plus, SquareTerminal, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { RowList } from "@/components/prs/RowList";
import { NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { addableRepos, memberKey, threadAt } from "@/lib/projects";
import { addToWorkspace, newTerminalIn, removeFromWorkspace } from "@/stores/projectActions";
import { openWorktreeTab } from "@/stores/worktreePanel";
import { useReposStore } from "@/stores/repos";
import { runSessionIn } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RowAction, WorktreeState } from "./WorktreeState";

export const MEMBER_ROW_HEIGHT = 32;
/** The panel layout's two-line rows: project and actions, then the worktree state. */
export const PANEL_MEMBER_ROW_HEIGHT = 48;

interface Member {
  repoId: string;
  path: string;
}

/**
 * The page layout: one line per member (Projects page). The panel layout: two lines, for
 * the side panel's workspace surface at down to 280px, with the thread's current member
 * marked and a Run in action on the others.
 */
export type MembersLayout = "page" | "panel";

interface RowOptions {
  workspaceId: string;
  /** The thread whose cwd is marked ("runs here") and that Run in moves; none on the Projects page. */
  threadId?: string;
  /** Opens the member (default: select its worktree overview). The panel opens it as a tab instead. */
  onOpen?: (repoId: string, path: string) => void;
}

/** Where the thread is relative to this member: runs here, a Run in is queued here, or neither. */
function useThreadAt(threadId: string | undefined, path: string): "current" | "queued" | null {
  return useSessionsStore((s) => threadAt(threadId ? s.byId[threadId] : undefined, path));
}

/** The panel layout's row: project (current marker) and actions, then branch and state. */
function PanelMemberRow({ workspaceId, member, threadId, onOpen }: RowOptions & { member: Member }) {
  const name = useReposStore((s) => s.byId[member.repoId]?.name ?? member.repoId);
  const at = useThreadAt(threadId, member.path);
  const open = () => {
    (onOpen ?? ((repoId, path) => openWorktreeTab("current", repoId, path)))(member.repoId, member.path);
  };
  return (
    <NavRow navKey={memberKey(workspaceId, member.repoId)} className="group/member flex h-full flex-col justify-center gap-0.5 px-2 text-sm" title={`${member.path}\nEnter or double-click: open`}>
      <span className="flex min-w-0 items-center gap-1.5" data-testid="workspace-member" data-repo={member.repoId} data-current={at === "current" || undefined}>
        <FolderGit2 className="size-3.5 shrink-0 text-sky-400/90" aria-hidden />
        <span className="min-w-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        {at && (
          <span
            className={cn("shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium", at === "current" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300")}
            title={at === "current" ? "The thread runs in this worktree" : "The thread moves here once it is idle at its prompt (/cd)"}
            data-testid="member-at"
          >
            {at === "current" ? "here" : "queued"}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover/member:opacity-100 group-aria-selected/member:opacity-100 group-focus-within/member:opacity-100">
          <RowAction label={`Open ${name} in a tab`} testId="member-open" onClick={open}>
            <PanelRightOpen />
          </RowAction>
          {threadId && at !== "current" && (
            <RowAction label={`Run the thread in ${name}`} testId="member-run-in" onClick={() => void runSessionIn(threadId, member.repoId)}>
              <ArrowRightLeft />
            </RowAction>
          )}
          <RowAction label="New terminal here" testId="member-terminal" onClick={() => void newTerminalIn(member.repoId, member.path)}>
            <SquareTerminal />
          </RowAction>
          <RowAction label={`Remove ${name} from the workspace`} destructive testId="member-remove" onClick={() => void removeFromWorkspace(workspaceId, member.repoId)}>
            <X />
          </RowAction>
        </span>
      </span>
      <span className="flex min-w-0 items-center pl-5">
        <WorktreeState repoId={member.repoId} path={member.path} showPath={false} />
      </span>
    </NavRow>
  );
}

function MemberRow({ workspaceId, member }: { workspaceId: string; member: Member }) {
  const name = useReposStore((s) => s.byId[member.repoId]?.name ?? member.repoId);
  return (
    <NavRow navKey={memberKey(workspaceId, member.repoId)} className="group/member flex h-full items-center gap-2 px-2 text-sm" title={`${member.path}\nEnter or double-click: show the worktree in the side panel`}>
      <span className="flex h-full min-w-0 flex-1 items-center gap-2" data-testid="workspace-member" data-repo={member.repoId}>
        <FolderGit2 className="size-3.5 shrink-0 text-sky-400/90" aria-hidden />
        <span className="w-32 shrink-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        <WorktreeState repoId={member.repoId} path={member.path} />
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-hover/member:opacity-100 group-aria-selected/member:opacity-100">
        <RowAction label="New terminal here" onClick={() => void newTerminalIn(member.repoId, member.path)}>
          <SquareTerminal />
        </RowAction>
        <RowAction label={`Remove ${name} from the workspace`} destructive testId="member-remove" onClick={() => void removeFromWorkspace(workspaceId, member.repoId)}>
          <X />
        </RowAction>
      </span>
    </NavRow>
  );
}

/** "Add project": the registered projects that are not members yet (workspace.add-repo). */
function AddMember({ workspaceId }: { workspaceId: string }) {
  const ws = useWorkspacesStore((s) => s.byId[workspaceId]);
  const addable = useReposStore(useShallow((s) => addableRepos(ws, s)));
  const names = useReposStore(useShallow((s) => addable.map((id) => s.byId[id]?.name ?? id)));
  const [adding, setAdding] = useState<{ id: string; name: string } | null>(null);
  const groups = useMemo<PickerGroup[]>(() => [{ heading: "Add a project", options: addable.map((id, i) => ({ value: id, label: names[i] ?? id })) }], [addable, names]);
  return (
    <ComposerPicker
      label="Add project"
      icon={Plus}
      text={adding ? `Adding ${adding.name}…` : "Add project"}
      value=""
      groups={groups}
      disabled={adding !== null}
      filterPlaceholder="Filter projects…"
      status={addable.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">Every project is a member.</p> : undefined}
      data-testid="workspace-add-member"
      onChange={(repoId) => {
        setAdding({ id: repoId, name: names[addable.indexOf(repoId)] ?? repoId });
        void addToWorkspace(workspaceId, repoId).finally(() => {
          setAdding(null);
        });
      }}
    />
  );
}

/**
 * A workspace's members: per member its project and worktree state (branch, changes,
 * ahead/behind, pull request) with open, new terminal and remove actions, then "Add
 * project". The Projects page uses the page layout per workspace; the side panel's
 * workspace surface the panel layout, with its thread and a tab opener. Rows are
 * NavRows: put it inside a NavProvider for keyboard navigation (outside one they are
 * plain rows). Long lists virtualize (RowList).
 */
export function WorkspaceMembers({
  workspaceId,
  showAdd = true,
  layout = "page",
  threadId,
  onOpen,
}: {
  workspaceId: string;
  showAdd?: boolean;
  layout?: MembersLayout;
  threadId?: string;
  onOpen?: (repoId: string, path: string) => void;
}) {
  const keys = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.repoId}\u0000${m.worktreePath}`)));
  const members = useMemo<Member[]>(
    () =>
      keys.map((k) => {
        const [repoId = "", path = ""] = k.split("\u0000");
        return { repoId, path };
      }),
    [keys],
  );
  return (
    <div className="flex flex-col gap-1" data-testid="workspace-members" data-workspace={workspaceId}>
      {members.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">No members.</p>
      ) : (
        <RowList
          rows={members}
          rowKey={(m) => memberKey(workspaceId, m.repoId)}
          rowHeight={layout === "panel" ? PANEL_MEMBER_ROW_HEIGHT : MEMBER_ROW_HEIGHT}
          testId="workspace-member-list"
          render={(m) => (layout === "panel" ? <PanelMemberRow workspaceId={workspaceId} member={m} threadId={threadId} onOpen={onOpen} /> : <MemberRow workspaceId={workspaceId} member={m} />)}
        />
      )}
      {showAdd && (
        <div className="px-1">
          <AddMember workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}
