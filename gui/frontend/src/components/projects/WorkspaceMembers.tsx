import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderGit2, FolderOpen, Plus, SquareTerminal, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { RowList } from "@/components/prs/RowList";
import { NavRow } from "@/lib/NavRow";
import { addableRepos, memberKey } from "@/lib/projects";
import { addToWorkspace, newTerminalIn, openWorktree, removeFromWorkspace } from "@/stores/projectActions";
import { useReposStore } from "@/stores/repos";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RowAction, WorktreeState } from "./WorktreeState";

export const MEMBER_ROW_HEIGHT = 32;

interface Member {
  repoId: string;
  path: string;
}

function MemberRow({ workspaceId, member }: { workspaceId: string; member: Member }) {
  const name = useReposStore((s) => s.byId[member.repoId]?.name ?? member.repoId);
  return (
    <NavRow navKey={memberKey(workspaceId, member.repoId)} className="group/member flex h-full items-center gap-2 px-2 text-sm" title={member.path}>
      <span className="flex h-full min-w-0 flex-1 items-center gap-2" data-testid="workspace-member" data-repo={member.repoId}>
        <FolderGit2 className="size-3.5 shrink-0 text-sky-400/90" aria-hidden />
        <span className="w-32 shrink-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        <WorktreeState repoId={member.repoId} path={member.path} />
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-hover/member:opacity-100 group-aria-selected/member:opacity-100">
        <RowAction label="Open worktree" onClick={() => { openWorktree(member.repoId, member.path); }}>
          <FolderOpen />
        </RowAction>
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
 * project". The Projects page uses it per workspace; the right panel's workspace surface
 * (step 5) is meant to reuse it. Rows are NavRows: put it inside a NavProvider for
 * keyboard navigation (outside one they are plain rows).
 */
export function WorkspaceMembers({ workspaceId, showAdd = true }: { workspaceId: string; showAdd?: boolean }) {
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
        <RowList rows={members} rowKey={(m) => memberKey(workspaceId, m.repoId)} rowHeight={MEMBER_ROW_HEIGHT} render={(m) => <MemberRow workspaceId={workspaceId} member={m} />} />
      )}
      {showAdd && (
        <div className="px-1">
          <AddMember workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}
