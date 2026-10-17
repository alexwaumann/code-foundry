import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { ProjectRowGroups } from "./ProjectRows";
import { useProjectRows } from "./useProjectRows";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { draftKey } from "@/lib/compose";
import { composeIn, composeInWorkspace, composeNoProject } from "@/stores/compose";
import { addProject } from "@/stores/projectActions";
import { getUiContext } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

/** cmdk value of the empty state's row (repo.add). */
const ADD_PROJECT_VALUE = "__add-project";

/** The row to highlight first: the active thread's workspace, else the active project. */
function initialValue(): string | undefined {
  const ctx = getUiContext();
  const ws = useThreadsStore.getState().byId[ctx.activeThreadId]?.workspaceId;
  if (ws && useWorkspacesStore.getState().byId[ws]) return draftKey({ kind: "workspace", workspaceId: ws });
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
 * listed above projects (ProjectRows), "No project" last; picking any opens the
 * new-thread composer for it. The active thread's workspace, else the project in the
 * current context, is highlighted first; cmd+1..9 pick projects by position. With no
 * projects yet, "Add a project…" comes first and "No project" still starts a thread;
 * with some, it is the last row.
 */
export function ProjectPicker({ close }: { close: () => void }) {
  const { workspaces, projects: order, loaded } = useProjectRows();
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
  const pickNoProject = () => {
    leave();
    composeNoProject();
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
        <CommandEmpty>{!loaded ? "Loading projects…" : "No matching projects."}</CommandEmpty>
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
        <ProjectRowGroups
          workspaces={workspaces}
          projects={order}
          soloHeading="New thread in…"
          shortcuts
          onPickProject={pick}
          onPickWorkspace={pickWorkspace}
          onPickNoProject={loaded ? pickNoProject : undefined}
        />
        {loaded && order.length > 0 && (
          // The way to a project that is not listed yet: the Add Project dialog (repo.add),
          // last, under a border. Always shown, so a search that finds nothing still offers it.
          <CommandGroup forceMount className="border-t">
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
              <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                <FolderPlus className="size-4" />
              </span>
              <span className="truncate font-medium">Add a project…</span>
              <span className="truncate text-caption">a folder on this Mac, or from GitHub</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-caption-sm" data-testid="picker-hints">
        {hints.map(([key, label]) => (
          <span key={key} className="flex items-center gap-1">
            <Kbd size="sm">{key}</Kbd>
            {label}
          </span>
        ))}
      </div>
    </Command>
  );
}
