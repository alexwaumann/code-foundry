import { useShallow } from "zustand/react/shallow";
import { Check, Layers } from "lucide-react";
import { CommandGroup, CommandItem, CommandShortcut } from "@/components/ui/command";
import { formatChord } from "@/keys/chord";
import { draftKey, projectHue, projectInitials, repoSource } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { useReposStore } from "@/stores/repos";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * The rows the project pickers list (cmd+N's ProjectPicker and the composer heading's
 * ProjectSwitcher): workspaces above projects, each with its badge and a muted detail
 * line. One place for the markup and the order; the pickers add their own chrome.
 */

/** Two-letter badge with a hue hashed from the project name. */
export function ProjectBadge({ name, className }: { name: string; className?: string }) {
  const hue = projectHue(name);
  return (
    <span
      aria-hidden
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tracking-wide text-white ${className ?? ""}`}
      style={{ backgroundColor: `oklch(0.55 0.13 ${String(hue)})` }}
    >
      {projectInitials(name)}
    </span>
  );
}

/** cmdk value of a workspace row: its target's draftKey (project rows use the repo id). */
const workspaceValue = (workspaceId: string) => draftKey({ kind: "workspace", workspaceId });

/** The check on the row of the picker's current target. */
function CurrentMark() {
  return <Check aria-label="Current" className="ml-auto size-3.5 shrink-0 text-muted-foreground" data-testid="picker-current" />;
}

function ProjectRow({ id, index, current, onPick }: { id: string; index?: number; current: boolean; onPick: (id: string) => void }) {
  const name = useReposStore((s) => s.byId[id]?.name ?? id);
  const path = useReposStore((s) => s.byId[id]?.path ?? "");
  const source = useReposStore((s) => {
    const r = s.byId[id];
    return r ? repoSource(r) : "";
  });
  return (
    <CommandItem
      value={id}
      keywords={[name, path, source]}
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
        <span className="truncate text-xs text-muted-foreground" data-testid="project-source">
          {source} · {tildify(path)}
        </span>
      </span>
      {current && <CurrentMark />}
      {index !== undefined && index < 9 && <CommandShortcut>{formatChord(`cmd+${String(index + 1)}`)}</CommandShortcut>}
    </CommandItem>
  );
}

function WorkspaceRow({ id, current, onPick }: { id: string; current: boolean; onPick: (id: string) => void }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const branch = useWorkspacesStore((s) => s.byId[id]?.branch ?? "");
  const memberIds = useWorkspacesStore(useShallow((s) => (s.byId[id]?.members ?? []).map((m) => m.repoId)));
  // Member project names, in member order (repos the store does not know show their id).
  const projects = useReposStore(useShallow((s) => memberIds.map((r) => s.byId[r]?.name ?? r)));
  return (
    <CommandItem
      value={workspaceValue(id)}
      keywords={[name, branch, ...projects]}
      onSelect={() => {
        onPick(id);
      }}
      data-workspace={id}
      data-members={memberIds.join(",")}
      data-current={current || undefined}
      className="gap-3 py-2"
    >
      <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Layers className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground" data-testid="workspace-detail">
          {branch} · {projects.join(", ")}
        </span>
      </span>
      {current && <CurrentMark />}
    </CommandItem>
  );
}

/**
 * The "Workspaces" group (when there are any) above the projects. The projects' heading
 * is "Projects" next to workspaces, else `soloHeading` (none when omitted).
 */
export function ProjectRowGroups({
  workspaces,
  projects,
  soloHeading,
  shortcuts = false,
  current,
  onPickProject,
  onPickWorkspace,
}: {
  workspaces: readonly string[];
  projects: readonly string[];
  soloHeading?: string;
  /** cmd+1..9 hints on the first nine projects (the picker handles the keys). */
  shortcuts?: boolean;
  /** draftKey of the target whose row gets a check. */
  current?: string;
  onPickProject: (id: string) => void;
  onPickWorkspace: (id: string) => void;
}) {
  return (
    <>
      {workspaces.length > 0 && (
        <CommandGroup heading="Workspaces">
          {workspaces.map((id) => (
            <WorkspaceRow key={id} id={id} current={current === workspaceValue(id)} onPick={onPickWorkspace} />
          ))}
        </CommandGroup>
      )}
      {projects.length > 0 && (
        <CommandGroup heading={workspaces.length > 0 ? "Projects" : soloHeading}>
          {projects.map((id, i) => (
            <ProjectRow key={id} id={id} index={shortcuts ? i : undefined} current={current === id} onPick={onPickProject} />
          ))}
        </CommandGroup>
      )}
    </>
  );
}
