import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Folder, FolderPlus, MapPin, Unlink } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { useProjectKind } from "@/components/icons/projectKind";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { memberCaption, memberKey } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { addableProjects, PRIMARY_WORKSPACE } from "@/lib/workspaceCard";
import { useProjectsStore } from "@/stores/projects";
import { addWorkspaceProject, removeWorkspaceProject, setWorkspacePrimary } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { KindIcon, Pill, SectionHeader } from "./bits";

const MEMBER_ROW_HEIGHT = 44;

/** The mark on where new threads in the workspace start (its default primary). */
function StartsHere() {
  return (
    <Pill tone="info" small data-testid="workspace-default">
      <MapPin aria-hidden />
      starts here
    </Pill>
  );
}

/** A row's hover action: a small ghost button with its label (mouse; the palette reaches the same commands). */
function HoverAction({ label, icon, onClick, testId, destructive }: { label: string; icon: React.ReactNode; onClick: () => void; testId: string; destructive?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      tabIndex={-1}
      data-testid={testId}
      className={cn("font-normal text-cf-text-secondary hover:text-cf-text", destructive && "hover:text-cf-error-text")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
    >
      {icon}
      {label}
    </Button>
  );
}

/** The trailing hover actions of a row: hidden at rest, shown on hover or with the keyboard cursor on it. */
function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/m:opacity-100 group-focus-within/m:opacity-100 group-aria-selected/m:opacity-100" data-testid="member-actions">
      {children}
    </span>
  );
}

const ROW = "group/m flex h-full items-center gap-2.5 rounded-none border-cf-divider px-3.5 text-body";

/**
 * The workspace's own folder as where new threads can start ("workspace" as the default
 * primary): a rooted workspace's root, always shown; a synthetic workspace's folder only
 * while it is the default (its projects otherwise say where threads start). Not a keyboard
 * row (nothing to open); Open in Finder shows it.
 */
function FolderRow({ workspaceId, first }: { workspaceId: string; first: boolean }) {
  const root = useWorkspacesStore((s) => s.byId[workspaceId]?.rootPath ?? "");
  const rootMissing = useWorkspacesStore((s) => s.byId[workspaceId]?.rootMissing === true);
  const isDefault = useWorkspacesStore((s) => s.byId[workspaceId]?.defaultPrimary === PRIMARY_WORKSPACE);
  if (!root && !isDefault) return null;
  return (
    <div className={cn(ROW, "h-11", !first && "border-t")} data-testid="workspace-folder" data-default={isDefault || undefined}>
      <Folder className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
      <span className="shrink-0 font-medium">Workspace folder</span>
      {isDefault && <StartsHere />}
      {root ? (
        <Tip label={rootMissing ? `${root} is missing (moved or renamed?): workspace set-root points the workspace at its new place` : root}>
          <span className="min-w-0 truncate text-caption text-cf-text-muted" data-testid="workspace-root" data-missing={rootMissing || undefined}>
            {tildify(root)}
          </span>
        </Tip>
      ) : (
        <span className="min-w-0 truncate text-caption text-cf-text-muted">kept by the app</span>
      )}
      {rootMissing && (
        <span className="shrink-0 text-caption text-cf-error-text" data-testid="workspace-root-missing">
          missing
        </span>
      )}
      {!isDefault && (
        <RowActions>
          <HoverAction label="Start here" icon={<MapPin />} testId="member-make-default" onClick={() => void setWorkspacePrimary(workspaceId, PRIMARY_WORKSPACE)} />
        </RowActions>
      )}
    </div>
  );
}

/**
 * One member project: kind, name, "starts here" on the default primary, its caption (the
 * GitHub slug, "local only", …); hover: Start here and Remove. A double-click or Enter
 * shows its main worktree's changes in the page's panel; an unregistered one (its id, "not
 * registered") opens nothing.
 */
function MemberRow({ workspaceId, projectId, first }: { workspaceId: string; projectId: string; first: boolean }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const known = useProjectsStore((s) => s.byId[projectId] !== undefined);
  const caption = useProjectsStore((s) => {
    const p = s.byId[projectId];
    return p ? memberCaption(p) : "";
  });
  const kind = useProjectKind(projectId);
  const isDefault = useWorkspacesStore((s) => s.byId[workspaceId]?.defaultPrimary === projectId);
  return (
    <NavRow navKey={memberKey(workspaceId, projectId)} className={cn(ROW, !first && "border-t")}>
      <span className="flex h-full min-w-0 flex-1 items-center gap-2.5" data-testid="workspace-member" data-project={projectId} data-default={isDefault || undefined} data-unregistered={!known || undefined}>
        <KindIcon kind={kind} />
        <span className="min-w-0 shrink truncate font-medium" data-testid="member-name">
          {name}
        </span>
        {isDefault && <StartsHere />}
        {known ? (
          <span className="min-w-0 truncate text-caption text-cf-text-muted" data-testid="member-caption">
            {caption}
          </span>
        ) : (
          <span className="shrink-0 text-caption text-cf-warning-text">not registered</span>
        )}
        <RowActions>
          {!isDefault && <HoverAction label="Start here" icon={<MapPin />} testId="member-make-default" onClick={() => void setWorkspacePrimary(workspaceId, projectId)} />}
          <HoverAction label="Remove" icon={<Unlink />} destructive testId="member-remove" onClick={() => void removeWorkspaceProject(workspaceId, projectId)} />
        </RowActions>
      </span>
    </NavRow>
  );
}

/** "Add project": the registered projects that are not members yet (workspace.add-project). */
function AddMember({ workspaceId }: { workspaceId: string }) {
  const members = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => m.projectId)));
  const addable = useProjectsStore(useShallow((s) => addableProjects(members, s)));
  const names = useProjectsStore(useShallow((s) => addable.map((id) => s.byId[id]?.name ?? id)));
  const [adding, setAdding] = useState<string | null>(null);
  const groups = useMemo<PickerGroup[]>(() => [{ heading: "Add a project", options: addable.map((id, i) => ({ value: id, label: names[i] ?? id })) }], [addable, names]);
  return (
    <ComposerPicker
      label="Add project"
      icon={FolderPlus}
      text={adding ? `Adding ${adding}…` : "Add project"}
      value=""
      groups={groups}
      disabled={adding !== null}
      filterPlaceholder="Filter projects…"
      status={addable.length === 0 ? <p className="text-caption">Every project is in it.</p> : undefined}
      className="font-normal text-cf-text-secondary"
      data-testid="workspace-add-member"
      onChange={(projectId) => {
        setAdding(names[addable.indexOf(projectId)] ?? projectId);
        void addWorkspaceProject(workspaceId, projectId).finally(() => {
          setAdding(null);
        });
      }}
    />
  );
}

/** The Projects card: the workspace's folder (when rooted, or where threads start), its projects by name, Add project. */
export function WorkspaceProjects({ workspaceId, members }: { workspaceId: string; members: readonly string[] }) {
  const folderShown = useWorkspacesStore((s) => {
    const w = s.byId[workspaceId];
    return Boolean(w?.rootPath) || w?.defaultPrimary === PRIMARY_WORKSPACE;
  });
  const empty = members.length === 0 && !folderShown;
  return (
    <div data-testid="workspace-projects">
      <SectionHeader label="Projects" detail="every thread checks these out together on one branch" right={<AddMember workspaceId={workspaceId} />} testId="workspace-projects-title" />
      <div className="overflow-hidden rounded-lg border bg-cf-surface" data-testid="workspace-members" data-workspace={workspaceId}>
        <FolderRow workspaceId={workspaceId} first />
        {members.length > 0 && (
          <RowList
            rows={members}
            rowKey={(p) => memberKey(workspaceId, p)}
            rowHeight={MEMBER_ROW_HEIGHT}
            testId="workspace-member-list"
            render={(p) => <MemberRow workspaceId={workspaceId} projectId={p} first={!folderShown && p === members[0]} />}
          />
        )}
        {empty && <p className="px-3.5 py-3 text-body-sm text-cf-text-muted" data-testid="workspace-members-empty">No projects yet. Add project puts one in it.</p>}
      </div>
    </div>
  );
}
