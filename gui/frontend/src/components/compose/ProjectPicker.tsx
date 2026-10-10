import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderPlus, Layers } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { formatChord } from "@/keys/chord";
import { projectHue, projectInitials, repoSource } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import { addProject } from "@/stores/projectActions";
import { getUiContext } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useWorkspaceOrder, useWorkspacesStore } from "@/stores/workspaces";

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

function ProjectRow({ id, index, onPick }: { id: string; index: number; onPick: (id: string) => void }) {
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
      className="gap-3 py-2"
    >
      <ProjectBadge name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground" data-testid="project-source">
          {source} · {tildify(path)}
        </span>
      </span>
      {index < 9 && <CommandShortcut>{formatChord(`cmd+${String(index + 1)}`)}</CommandShortcut>}
    </CommandItem>
  );
}

/** cmdk value of a workspace row (project rows use the repo id). */
const workspaceValue = (id: string) => `ws:${id}`;

/** cmdk value of the empty state's row (repo.add). */
const ADD_PROJECT_VALUE = "__add-project";

function WorkspaceRow({ id, onPick }: { id: string; onPick: (id: string) => void }) {
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
    </CommandItem>
  );
}

/** The row to highlight first: the active thread's workspace, else the active project. */
function initialValue(): string | undefined {
  const ctx = getUiContext();
  const ws = useSessionsStore.getState().byId[ctx.activeSessionId]?.workspaceId;
  if (ws && useWorkspacesStore.getState().byId[ws]) return workspaceValue(ws);
  const id = ctx.activeRepoId;
  return id && useReposStore.getState().byId[id] ? id : undefined;
}

const hints = [
  ["↑↓", "Navigate"],
  ["Enter", "Select"],
  ["Backspace", "Back"],
  ["Esc", "Close"],
] as const;

/**
 * The palette's project picker: session.new's presentation in the GUI. Workspaces are
 * listed above projects; picking either opens the new-thread composer for it. The
 * active thread's workspace, else the project in the current context, is highlighted
 * first; cmd+1..9 pick projects by position.
 */
export function ProjectPicker({ close }: { close: () => void }) {
  const order = useReposStore(useShallow((s) => s.order));
  const loaded = useReposStore((s) => s.loaded);
  const workspaces = useWorkspaceOrder();
  // Highlight what the user was looking at when the picker opened.
  // With no projects, the empty state's Add a project row.
  const [initial] = useState(() => initialValue() ?? (useReposStore.getState().order.length === 0 ? ADD_PROJECT_VALUE : undefined));
  const [query, setQuery] = useState("");

  const leave = () => {
    // The composer takes focus, not whatever had it before the picker opened.
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
    close();
  };
  const pick = (id: string) => {
    leave();
    composeIn(id);
  };
  const pickWorkspace = (id: string) => {
    leave();
    composeInWorkspace(id);
  };

  return (
    <Command
      loop
      defaultValue={initial}
      data-testid="palette"
      data-mode="projects"
      onKeyDown={(e) => {
        if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
          const id = order[Number(e.key) - 1];
          e.preventDefault();
          if (id) pick(id);
          return;
        }
        if (e.key === "Backspace" && query === "") {
          e.preventDefault();
          useUiStore.getState().openPalette();
        }
      }}
    >
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={workspaces.length > 0 ? "Search workspaces and projects…" : "Search projects…"}
        aria-label={workspaces.length > 0 ? "Search workspaces and projects" : "Search projects"}
      />
      <CommandList>
        <CommandEmpty>{!loaded ? "Loading projects…" : order.length === 0 ? "No projects yet." : "No matching projects."}</CommandEmpty>
        {loaded && order.length === 0 && (
          // The empty state's way forward: the Add Project dialog (repo.add).
          <CommandGroup heading="No projects yet">
            <CommandItem
              forceMount
              value={ADD_PROJECT_VALUE}
              onSelect={() => {
                close();
                addProject();
              }}
              data-testid="picker-add-project"
              className="gap-3 py-2"
            >
              <FolderPlus />
              Add a project…
            </CommandItem>
          </CommandGroup>
        )}
        {workspaces.length > 0 && (
          <CommandGroup heading="Workspaces">
            {workspaces.map((id) => (
              <WorkspaceRow key={id} id={id} onPick={pickWorkspace} />
            ))}
          </CommandGroup>
        )}
        {order.length > 0 && (
          <CommandGroup heading={workspaces.length > 0 ? "Projects" : "New thread in…"}>
            {order.map((id, i) => (
              <ProjectRow key={id} id={id} index={i} onPick={pick} />
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="picker-hints">
        {hints.map(([key, label]) => (
          <span key={key} className="flex items-center gap-1">
            <kbd className="rounded border border-border bg-muted/60 px-1 font-sans text-[10px] text-foreground/80">{key}</kbd>
            {label}
          </span>
        ))}
      </div>
    </Command>
  );
}
