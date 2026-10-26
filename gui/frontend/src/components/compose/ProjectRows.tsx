import { useShallow } from "zustand/react/shallow";
import { Check, House, Layers } from "lucide-react";
import { byName, NO_PROJECT_TERMS, projectSearchTerms } from "./useProjectRows";
import { CommandGroup, CommandItem, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { formatChord } from "@/keys/chord";
import { draftKey, HOME_KEY, projectHue, projectInitials, projectSource } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { NO_PROJECT } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * The rows the project pickers list: one place for their markup. cmd+N's ProjectPicker
 * shows them as one flat ranked list ("No project", workspaces, projects, each with its
 * cmd+number); the composer heading's ProjectSwitcher groups them (ProjectRowGroups:
 * workspaces above projects, "No project" last). The pickers add their own chrome.
 */

/** Two-letter badge with a hue hashed from the project name. */
export function ProjectBadge({ name, className }: { name: string; className?: string }) {
  const hue = projectHue(name);
  return (
    <span
      aria-hidden
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-overline font-semibold tracking-wide text-white ${className ?? ""}`}
      style={{ backgroundColor: `oklch(0.55 0.13 ${String(hue)})` }}
    >
      {projectInitials(name)}
    </span>
  );
}

/** The House badge that stands for "No project" where a project shows its two letters. */
export function NoProjectBadge({ className }: { className?: string }) {
  return (
    <span aria-hidden className={`flex size-6 shrink-0 items-center justify-center rounded-md bg-cf-surface-sunken text-cf-text-muted ${className ?? ""}`}>
      <House className="size-3.5" />
    </span>
  );
}

/** cmdk value of a workspace row: its target's draftKey (project rows use the project id). */
const workspaceValue = (workspaceId: string) => draftKey({ kind: "workspace", workspaceId });

/** The check on a row the picker has picked (the current target, or a project or workspace of the composer's set). */
function CurrentMark() {
  return <Check aria-label="Current" className="ml-auto size-3.5 shrink-0 text-cf-text-muted" data-testid="picker-current" />;
}

/** The cmd+number hint on one of the first nine rows (the picker handles the keys). */
function RowShortcut({ index }: { index?: number }) {
  if (index === undefined || index >= 9) return null;
  return <CommandShortcut>{formatChord(`cmd+${String(index + 1)}`)}</CommandShortcut>;
}

/** A project's row. `index`: its position in the list, for a cmd+number hint. */
export function ProjectRow({ id, index, current, onPick }: { id: string; index?: number; current: boolean; onPick: (id: string) => void }) {
  const name = useProjectsStore((s) => s.byId[id]?.name ?? id);
  const path = useProjectsStore((s) => s.byId[id]?.path ?? "");
  const source = useProjectsStore((s) => {
    const r = s.byId[id];
    return r ? projectSource(r) : "";
  });
  return (
    <CommandItem
      value={id}
      keywords={projectSearchTerms(name, path, source)}
      onSelect={() => {
        onPick(id);
      }}
      data-project={id}
      data-current={current || undefined}
      className="gap-3 py-2"
    >
      <ProjectBadge name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-caption" data-testid="project-source">
          {source} · {tildify(path)}
        </span>
      </span>
      {current && <CurrentMark />}
      <RowShortcut index={index} />
    </CommandItem>
  );
}

/** A workspace's row: its name over its member projects. `index` as for ProjectRow. */
export function WorkspaceRow({ id, index, current, onPick }: { id: string; index?: number; current: boolean; onPick: (id: string) => void }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const memberIds = useWorkspacesStore(useShallow((s) => (s.byId[id]?.members ?? []).map((m) => m.projectId)));
  // Member project names by name, case-insensitively (projects the store does not know show their id).
  const projects = useProjectsStore(useShallow((s) => memberIds.map((r) => s.byId[r]?.name ?? r).sort(byName)));
  return (
    <CommandItem
      value={workspaceValue(id)}
      keywords={[name, ...projects]}
      onSelect={() => {
        onPick(id);
      }}
      data-workspace={id}
      data-members={memberIds.join(",")}
      data-current={current || undefined}
      className="gap-3 py-2"
    >
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-cf-surface-sunken text-cf-text-muted">
        <Layers className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-caption" data-testid="workspace-detail">
          {projects.length === 0 ? "no projects" : projects.join(", ")}
        </span>
      </span>
      {current && <CurrentMark />}
      <RowShortcut index={index} />
    </CommandItem>
  );
}

/**
 * A thread without a project: it runs in the home directory (`~`). Its cmdk value is the
 * home target's draftKey. In cmd+N's list it is an ordinary row (first by default, so
 * Enter right after cmd+N starts a no-project thread); `index` as for ProjectRow.
 */
export function NoProjectRow({ index, current, onPick }: { index?: number; current: boolean; onPick: () => void }) {
  return (
    <CommandItem value={HOME_KEY} keywords={[...NO_PROJECT_TERMS]} onSelect={onPick} data-testid="picker-no-project" data-current={current || undefined} className="gap-3 py-2">
      <NoProjectBadge />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{NO_PROJECT}</span>
        <span className="truncate text-caption">~</span>
      </span>
      {current && <CurrentMark />}
      <RowShortcut index={index} />
    </CommandItem>
  );
}

/**
 * The composer ProjectSwitcher's grouped rows: the "Workspaces" group (when there are any)
 * above the projects, whose heading is "Projects" next to workspaces (none alone). With
 * `onPickNoProject`, a "No project" row after them all, below a separator.
 */
export function ProjectRowGroups({
  workspaces,
  projects,
  checked = () => false,
  onPickProject,
  onPickWorkspace,
  onPickNoProject,
}: {
  workspaces: readonly string[];
  projects: readonly string[];
  /** Whether a row (its cmdk value: a draftKey) gets a check: the current target, or what the composer's set has. */
  checked?: (value: string) => boolean;
  onPickProject: (id: string) => void;
  onPickWorkspace: (id: string) => void;
  onPickNoProject?: () => void;
}) {
  return (
    <>
      {workspaces.length > 0 && (
        <CommandGroup heading="Workspaces">
          {workspaces.map((id) => (
            <WorkspaceRow key={id} id={id} current={checked(workspaceValue(id))} onPick={onPickWorkspace} />
          ))}
        </CommandGroup>
      )}
      {projects.length > 0 && (
        <CommandGroup heading={workspaces.length > 0 ? "Projects" : undefined}>
          {projects.map((id) => (
            <ProjectRow key={id} id={id} current={checked(id)} onPick={onPickProject} />
          ))}
        </CommandGroup>
      )}
      {onPickNoProject && (
        <>
          {workspaces.length + projects.length > 0 && <CommandSeparator />}
          <CommandGroup>
            <NoProjectRow current={checked(HOME_KEY)} onPick={onPickNoProject} />
          </CommandGroup>
        </>
      )}
    </>
  );
}
