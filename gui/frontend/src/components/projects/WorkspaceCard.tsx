import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileText, Folder, FolderGit2, FolderOpen, Layers, Pencil, Plus, SquarePen, Star, Trash2, X } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { GithubMark } from "@/components/icons/GithubMark";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { NavRow } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { memberKey, projectKind, workspaceKey, type ProjectKind } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { addableProjects, instructionsName, PRIMARY_WORKSPACE, workspaceNameError, workspaceSummary } from "@/lib/workspaceCard";
import { composeInWorkspace } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import {
  addWorkspaceProject,
  editWorkspaceInstructions,
  openWorkspaceInstructions,
  removeWorkspace,
  removeWorkspaceProject,
  renameWorkspace,
  revealWorkspace,
  setWorkspacePrimary,
} from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { CollapseToggle } from "./CollapseToggle";
import { OverflowMenu } from "./OverflowMenu";
import { RowAction } from "./WorktreeState";

export const MEMBER_ROW_HEIGHT = 32;

const KIND_ICON: Record<ProjectKind, React.ComponentType<{ className?: string }>> = { github: GithubMark, git: FolderGit2, nogit: Folder };
const UNKNOWN_PROJECT = { githubSlug: "", remotes: [] };

/** The mark on where new threads in the workspace start (its default primary). */
function StartsHere() {
  return (
    <span className="shrink-0 rounded-sm bg-cf-highlight-surface px-1 text-caption-sm font-medium text-cf-highlight-text" data-testid="workspace-default">
      starts here
    </span>
  );
}

/** The trailing action slots of a card row (same width on every row, so the names line up). */
function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex w-12 shrink-0 items-center justify-end opacity-55 transition-opacity group-hover/m:opacity-100 group-focus-within/m:opacity-100 group-aria-selected/m:opacity-100" data-testid="member-actions">
      {children}
    </span>
  );
}

/** "Start new threads here": workspace.set-primary, or an empty slot on the row that is the default already. */
function MakeDefault({ workspaceId, primary, isDefault }: { workspaceId: string; primary: string; isDefault: boolean }) {
  if (isDefault) return <span className="size-6 shrink-0" aria-hidden />;
  return (
    <RowAction label="Start new threads here" testId="member-make-default" onClick={() => void setWorkspacePrimary(workspaceId, primary)}>
      <Star />
    </RowAction>
  );
}

/**
 * The workspace's own folder as a place new threads can start ("workspace" as the default
 * primary): its root, or the folder the app keeps for it. Not a keyboard row (nothing to
 * open); Reveal in Finder in the header shows it.
 */
function FolderRow({ workspaceId }: { workspaceId: string }) {
  const rooted = useWorkspacesStore((s) => (s.byId[workspaceId]?.rootPath ?? "") !== "");
  const isDefault = useWorkspacesStore((s) => s.byId[workspaceId]?.defaultPrimary === PRIMARY_WORKSPACE);
  return (
    <div className="group/m flex h-8 items-center gap-2 rounded-md pr-2 pl-6 text-body" data-testid="workspace-folder" data-default={isDefault || undefined}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Folder className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        <span className="shrink-0 font-medium">Workspace folder</span>
        <span className="min-w-0 truncate text-caption">{rooted ? "its root" : "kept by the app"}</span>
        {isDefault && <StartsHere />}
      </span>
      <RowActions>
        <MakeDefault workspaceId={workspaceId} primary={PRIMARY_WORKSPACE} isDefault={isDefault} />
        <span className="size-6 shrink-0" aria-hidden />
      </RowActions>
    </div>
  );
}

/** One member project: its kind, name, the default mark, then make default and remove. Enter or a double-click shows its main worktree in the page's panel. */
function MemberRow({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const known = useProjectsStore((s) => s.byId[projectId] !== undefined);
  const kind = useProjectsStore((s) => projectKind(s.byId[projectId] ?? UNKNOWN_PROJECT).kind);
  const isDefault = useWorkspacesStore((s) => s.byId[workspaceId]?.defaultPrimary === projectId);
  const Icon = KIND_ICON[kind];
  return (
    <NavRow navKey={memberKey(workspaceId, projectId)} className="group/m flex h-full items-center gap-2 rounded-md pr-2 pl-6 text-body">
      <span className="flex min-w-0 flex-1 items-center gap-2" data-testid="workspace-member" data-project={projectId} data-default={isDefault || undefined}>
        <Icon className={cn("size-3.5 shrink-0", kind === "github" ? "text-cf-info-text/90" : "text-cf-text-muted")} />
        <span className="min-w-0 truncate font-medium" data-testid="member-name">
          {name}
        </span>
        {!known && <span className="shrink-0 text-caption text-cf-warning-text">not registered</span>}
        {isDefault && <StartsHere />}
      </span>
      <RowActions>
        <MakeDefault workspaceId={workspaceId} primary={projectId} isDefault={isDefault} />
        <RowAction label={`Remove ${name} from the workspace`} destructive testId="member-remove" onClick={() => void removeWorkspaceProject(workspaceId, projectId)}>
          <X />
        </RowAction>
      </RowActions>
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
      icon={Plus}
      text={adding ? `Adding ${adding}…` : "Add project"}
      value=""
      groups={groups}
      disabled={adding !== null}
      filterPlaceholder="Filter projects…"
      status={addable.length === 0 ? <p className="text-caption">Every project is in it.</p> : undefined}
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

/** The instructions file (opens as a File tab in the page's panel), or "none yet"; then Edit instructions. */
function InstructionsLine({ workspaceId }: { workspaceId: string }) {
  const file = useWorkspacesStore((s) => s.byId[workspaceId]?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const name = instructionsName({ instructions: file });
  return (
    <div className="flex min-h-7 items-center gap-2" data-testid="workspace-instructions" data-file={file || undefined}>
      <span className="w-28 shrink-0 text-overline">Instructions</span>
      {file ? (
        <Tip label={file}>
          <Button type="button" variant="ghost" size="xs" className="-ml-1.5 min-w-0 text-code" data-testid="workspace-instructions-open" onClick={() => openWorkspaceInstructions(workspaceId)}>
            <FileText aria-hidden />
            <span className="truncate">{name}</span>
          </Button>
        </Tip>
      ) : (
        <span className="text-caption" data-testid="workspace-instructions-none">
          none yet
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ml-auto shrink-0 text-cf-text-muted hover:text-cf-text"
        disabled={busy}
        data-testid="workspace-edit-instructions"
        onClick={() => {
          setBusy(true);
          void editWorkspaceInstructions(workspaceId).finally(() => {
            setBusy(false);
          });
        }}
      >
        <SquarePen aria-hidden />
        {busy ? "Starting…" : "Edit instructions"}
      </Button>
    </div>
  );
}

/** The skills in the workspace's .claude/skills, by name, or "none yet". */
function SkillsLine({ workspaceId }: { workspaceId: string }) {
  const skills = useWorkspacesStore(useShallow((s) => [...(s.byId[workspaceId]?.skills ?? [])]));
  return (
    <div className="flex min-h-7 items-center gap-2" data-testid="workspace-skills">
      <span className="w-28 shrink-0 text-overline">Skills</span>
      {skills.length === 0 ? (
        <span className="text-caption" data-testid="workspace-skills-none">
          none yet
        </span>
      ) : (
        <span className="flex min-w-0 flex-wrap gap-1">
          {skills.map((n) => (
            <span key={n} className="rounded-sm border px-1.5 text-caption font-mono" data-testid="workspace-skill">
              {n}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The name, edited in place: Enter (or leaving the field) renames (workspace.rename),
 * Escape keeps the old one. Names are unique whatever their case; the daemon says so too.
 * Keys stay in the field (the page's list must not move meanwhile).
 */
function NameEditor({ workspaceId, name, onDone }: { workspaceId: string; name: string; onDone: () => void }) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape give the keyboard back to the page's list (the field unmounts).
  const backToList = () => {
    inputRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
  };
  const others = useWorkspacesStore(useShallow((s) => s.order.filter((x) => x !== workspaceId).map((x) => s.byId[x]?.name ?? "")));
  const changed = value.trim() !== name;
  const error = changed ? workspaceNameError(value, others) : "";
  const commit = () => {
    onDone();
    if (changed && !error) void renameWorkspace(workspaceId, value);
  };
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Input
        ref={inputRef}
        autoFocus
        value={value}
        aria-label="Workspace name"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid="workspace-name-input"
        className="h-6 w-48 px-1.5 text-body font-medium"
        onFocus={(e) => {
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        onClick={(e) => {
          e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            backToList();
            onDone();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (error) return;
            backToList();
            commit();
          }
        }}
        onBlur={() => {
          if (error) onDone();
          else commit();
        }}
      />
      {error && (
        <span className="truncate text-caption text-cf-error-text" data-testid="workspace-name-error">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A workspace on the Projects page (docs/notes/workspaces-v2-4-projects-page.md): its
 * name (double-click or Rename… to edit in place), root when it has one, its projects by
 * id with where new threads start marked (and the workspace's own folder as a choice),
 * add and remove a project, the instructions file and skills, Edit instructions (a thread
 * in the workspace's folder does the editing: panels read, the agent acts), Reveal in
 * Finder and Remove. Collapses like a project.
 */
export function WorkspaceCard({ id, collapsed, filtering }: { id: string; collapsed: boolean; filtering: boolean }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const root = useWorkspacesStore((s) => s.byId[id]?.rootPath ?? "");
  const rootMissing = useWorkspacesStore((s) => s.byId[id]?.rootMissing === true);
  const summary = useWorkspacesStore((s) => {
    const w = s.byId[id];
    return w ? workspaceSummary(w) : "";
  });
  const members = useWorkspacesStore(useShallow((s) => (s.byId[id]?.members ?? []).map((m) => m.projectId)));
  const [renaming, setRenaming] = useState(false);
  return (
    <section className="group/card rounded-lg border" data-testid="workspace" data-workspace={id} data-rooted={root ? true : undefined} data-collapsed={collapsed}>
      <NavRow navKey={workspaceKey(id)} className={cn("group/ws flex h-9 items-center gap-2 rounded-lg px-2", !collapsed && "rounded-b-none border-b")}>
        <CollapseToggle
          collapsed={collapsed}
          disabled={filtering}
          label={name}
          testId="workspace-collapse"
          onToggle={() => {
            useUiStore.getState().setWorkspaceCollapsed(id, !collapsed);
          }}
        />
        <Layers className="size-4 shrink-0 text-cf-highlight-text/90" aria-hidden />
        {renaming ? (
          <NameEditor
            workspaceId={id}
            name={name}
            onDone={() => {
              setRenaming(false);
            }}
          />
        ) : (
          <span
            className="truncate font-medium"
            data-testid="workspace-name"
            onDoubleClick={(e) => {
              // The name edits in place; the rest of the header opens the composer.
              e.stopPropagation();
              setRenaming(true);
            }}
          >
            {name}
          </span>
        )}
        {root && (
          <Tip label={rootMissing ? `${root} is missing (moved or renamed?): workspace set-root points the workspace at its new place` : root}>
            <span className="min-w-0 truncate text-caption font-mono" data-testid="workspace-root" data-missing={rootMissing || undefined}>
              {tildify(root)}
            </span>
          </Tip>
        )}
        {root && rootMissing && (
          <span className="shrink-0 text-caption text-cf-error-text" data-testid="workspace-root-missing">
            missing
          </span>
        )}
        {collapsed && (
          <span className="shrink-0 text-caption tabular-nums" data-testid="workspace-collapsed-summary">
            {summary}
          </span>
        )}
        <span
          className="ml-auto flex shrink-0 items-center opacity-70 transition-opacity group-hover/card:opacity-100 group-focus-within/ws:opacity-100 group-aria-selected/ws:opacity-100 has-[[aria-expanded=true]]:opacity-100"
          data-testid="workspace-actions"
        >
          <RowAction label="New thread in this workspace" testId="workspace-new-thread" onClick={() => { composeInWorkspace(id); }}>
            <SquarePen />
          </RowAction>
          <RowAction label="Reveal in Finder" testId="workspace-reveal" onClick={() => void revealWorkspace(id)}>
            <FolderOpen />
          </RowAction>
          <OverflowMenu
            label="More workspace actions"
            testId="workspace-more"
            items={[
              { label: "Rename…", icon: Pencil, testId: "workspace-rename", onSelect: () => { setRenaming(true); } },
              "separator",
              { label: "Remove workspace…", icon: Trash2, destructive: true, testId: "workspace-remove", onSelect: () => void removeWorkspace(id) },
            ]}
          />
        </span>
      </NavRow>
      {!collapsed && (
        <div className="flex flex-col gap-2 p-0.5 pb-2">
          <div className="flex flex-col" data-testid="workspace-members" data-workspace={id}>
            <FolderRow workspaceId={id} />
            {members.length > 0 && (
              <RowList rows={members} rowKey={(p) => memberKey(id, p)} rowHeight={MEMBER_ROW_HEIGHT} testId="workspace-member-list" render={(p) => <MemberRow workspaceId={id} projectId={p} />} />
            )}
            <div className="pt-0.5 pl-5">
              <AddMember workspaceId={id} />
            </div>
          </div>
          <div className="mx-2 flex flex-col gap-0.5 border-t px-4 pt-1.5">
            <InstructionsLine workspaceId={id} />
            <SkillsLine workspaceId={id} />
          </div>
        </div>
      )}
    </section>
  );
}
