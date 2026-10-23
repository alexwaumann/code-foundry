import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowRightLeft, FolderGit2, PanelRightOpen, Plus, SquareTerminal, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { RowList } from "@/components/prs/RowList";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { cn } from "@/lib/utils";
import { addableProjects, memberKey, threadAt } from "@/lib/projects";
import { newThreadTerminal } from "@/stores/bottomActions";
import { addToWorkspace, newTerminalIn, removeFromWorkspace } from "@/stores/projectActions";
import { openWorktreeTab } from "@/stores/worktreePanel";
import { useProjectsStore } from "@/stores/projects";
import { runThreadIn } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";
import { OverflowMenu } from "./OverflowMenu";
import { RowAction, WorktreeState } from "./WorktreeState";

export const MEMBER_ROW_HEIGHT = 32;
/** The panel layout's two-line rows: project and actions, then the worktree state. */
export const PANEL_MEMBER_ROW_HEIGHT = 48;

interface Member {
  projectId: string;
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
  onOpen?: (projectId: string, path: string) => void;
}

/** Where the thread is relative to this member: runs here, a Run in is queued here, or neither. */
function useThreadAt(threadId: string | undefined, path: string): "current" | "queued" | null {
  return useThreadsStore((s) => threadAt(threadId ? s.byId[threadId] : undefined, path));
}

/** The panel layout's row: project (current marker) and actions, then branch and state. */
function PanelMemberRow({ workspaceId, member, threadId, onOpen }: RowOptions & { member: Member }) {
  const name = useProjectsStore((s) => s.byId[member.projectId]?.name ?? member.projectId);
  const at = useThreadAt(threadId, member.path);
  const open = () => {
    (onOpen ?? ((projectId, path) => openWorktreeTab("current", projectId, path)))(member.projectId, member.path);
  };
  return (
    <NavRow navKey={memberKey(workspaceId, member.projectId)} className="group/member flex h-full flex-col justify-center gap-0.5 px-2 text-body" tip={member.path}>
      <span className="flex min-w-0 items-center gap-1.5" data-testid="workspace-member" data-project={member.projectId} data-current={at === "current" || undefined}>
        <FolderGit2 className="size-3.5 shrink-0 text-cf-info-text/90" aria-hidden />
        <span className="min-w-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        {at && (
          <Tip label={at === "current" ? "The thread runs in this worktree" : "The thread moves here once it is idle at its prompt"}>
            <span className={cn("shrink-0 rounded-sm px-1 text-caption-sm font-medium", at === "current" ? "bg-cf-success-surface text-cf-success-text" : "bg-cf-warning-surface text-cf-warning-text")} data-testid="member-at">
              {at === "current" ? "here" : "queued"}
            </span>
          </Tip>
        )}
        <span className="ml-auto flex shrink-0 items-center opacity-0 group-hover/member:opacity-100 group-aria-selected/member:opacity-100 group-focus-within/member:opacity-100">
          <RowAction label={`Open ${name} in a tab`} testId="member-open" onClick={open}>
            <PanelRightOpen />
          </RowAction>
          {threadId && at !== "current" && (
            <RowAction label={`Run the thread in ${name}`} testId="member-run-in" onClick={() => void runThreadIn(threadId, member.projectId)}>
              <ArrowRightLeft />
            </RowAction>
          )}
          {/* In a thread's panel the thread owns the shell (its bottom panel); else the Projects page's. */}
          <RowAction
            label="New terminal here"
            testId="member-terminal"
            onClick={() => void (threadId ? newThreadTerminal(threadId, member.path) : newTerminalIn(member.projectId, member.path))}
          >
            <SquareTerminal />
          </RowAction>
          <RowAction label={`Remove ${name} from the workspace`} destructive testId="member-remove" onClick={() => void removeFromWorkspace(workspaceId, member.projectId)}>
            <X />
          </RowAction>
        </span>
      </span>
      <span className="flex min-w-0 items-center pl-5">
        <WorktreeState projectId={member.projectId} path={member.path} showPath={false} />
      </span>
    </NavRow>
  );
}

function MemberRow({ workspaceId, member }: { workspaceId: string; member: Member }) {
  const name = useProjectsStore((s) => s.byId[member.projectId]?.name ?? member.projectId);
  return (
    <NavRow navKey={memberKey(workspaceId, member.projectId)} className="group/member flex h-full items-center gap-2 rounded-md px-2 text-body" tip={member.path}>
      <span className="flex h-full min-w-0 flex-1 items-center gap-2" data-testid="workspace-member" data-project={member.projectId}>
        <FolderGit2 className="size-3.5 shrink-0 text-cf-info-text/90" aria-hidden />
        <span className="w-32 shrink-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        <WorktreeState projectId={member.projectId} path={member.path} />
      </span>
      {/* Always shown, muted at rest; a fixed width so every member's state column ends at the same x. */}
      <span
        className="flex w-12 shrink-0 items-center justify-end opacity-55 transition-opacity group-hover/member:opacity-100 group-focus-within/member:opacity-100 group-aria-selected/member:opacity-100 has-[[aria-expanded=true]]:opacity-100"
        data-testid="member-actions"
      >
        <RowAction label="New terminal here" testId="member-terminal" onClick={() => void newTerminalIn(member.projectId, member.path)}>
          <SquareTerminal />
        </RowAction>
        <OverflowMenu
          label="More member actions"
          testId="member-more"
          items={[{ label: "Remove from workspace", icon: X, destructive: true, testId: "member-remove", onSelect: () => void removeFromWorkspace(workspaceId, member.projectId) }]}
        />
      </span>
    </NavRow>
  );
}

/** "Add project": the registered projects that are not members yet (workspace.add-project). */
function AddMember({ workspaceId }: { workspaceId: string }) {
  const ws = useWorkspacesStore((s) => s.byId[workspaceId]);
  const addable = useProjectsStore(useShallow((s) => addableProjects(ws, s)));
  const names = useProjectsStore(useShallow((s) => addable.map((id) => s.byId[id]?.name ?? id)));
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
      status={addable.length === 0 ? <p className="px-3 py-2 text-caption">Every project is a member.</p> : undefined}
      data-testid="workspace-add-member"
      onChange={(projectId) => {
        setAdding({ id: projectId, name: names[addable.indexOf(projectId)] ?? projectId });
        void addToWorkspace(workspaceId, projectId).finally(() => {
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
  onOpen?: (projectId: string, path: string) => void;
}) {
  const keys = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.projectId}\u0000${m.worktreePath}`)));
  const members = useMemo<Member[]>(
    () =>
      keys.map((k) => {
        const [projectId = "", path = ""] = k.split("\u0000");
        return { projectId, path };
      }),
    [keys],
  );
  return (
    <div className="flex flex-col gap-1" data-testid="workspace-members" data-workspace={workspaceId}>
      {members.length === 0 ? (
        <p className="px-2 text-body text-cf-text-muted">No members.</p>
      ) : (
        <RowList
          rows={members}
          rowKey={(m) => memberKey(workspaceId, m.projectId)}
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
