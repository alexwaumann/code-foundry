import { useMemo, useState } from "react";
import { FolderPlus } from "lucide-react";
import { NoProjectRow, ProjectRow, WorkspaceRow } from "./ProjectRows";
import { rankPickerRows, usePickerRows, type PickerRow } from "./useProjectRows";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { HOME_KEY } from "@/lib/compose";
import { composeIn, composeInWorkspace, composeNoProject } from "@/stores/compose";
import { addProject } from "@/stores/projectActions";
import { useUiStore } from "@/stores/ui";

/** cmdk value of the pinned "Add a project…" row (project.add). */
const ADD_PROJECT_VALUE = "__add-project";

const hints = [
  ["↑↓", "Navigate"],
  ["Enter", "Select"],
  ["Backspace", "Back"],
  ["Esc", "Close"],
] as const;

/**
 * The palette's project picker: thread.new's presentation in the GUI. One flat list, no
 * headings: "No project" first, then workspaces by name, then projects in registry order;
 * picking any opens the new-thread composer for it. The picker ranks the rows itself
 * (cmdk's filtering is off): a query keeps the rows that match, best first
 * (rankPickerRows), so what is on screen is the one list cmd+1..9 count in: cmd+1 is
 * always the top row. Opening with an empty query highlights "No project", so Enter
 * right after cmd+N starts a no-project thread.
 *
 * "Add a project…" is pinned below the scrolling rows, never filtered. It stays a cmdk
 * item inside CommandList (cmdk only moves to and selects items inside it), after the
 * rows' own scroll region, so the arrow keys reach it last and it wraps with `loop`. With
 * no projects yet (or none loaded) it is the highlighted row; so is it when a query
 * matches nothing.
 */
export function ProjectPicker({ close }: { close: () => void }) {
  const { rows, workspaces, projects, loaded } = usePickerRows();
  const [query, setQuery] = useState("");
  // The highlighted row (cmdk value) once cmdk has moved it (keys, pointer, a new query);
  // until then "No project", or Add a project while there are no projects.
  const [value, setValue] = useState<string | undefined>(undefined);
  const visible = useMemo(() => rankPickerRows(rows, query), [rows, query]);

  const leave = () => {
    // The composer takes focus, not whatever had it before the picker opened.
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
    close();
  };
  const pick = (row: PickerRow) => {
    leave();
    if (row.kind === "project") composeIn(row.id);
    else if (row.kind === "workspace") composeInWorkspace(row.id);
    else composeNoProject();
  };
  const rowFor = (row: PickerRow, index: number) => {
    const onPick = () => {
      pick(row);
    };
    if (row.kind === "project") return <ProjectRow key={row.value} id={row.id} index={index} current={false} onPick={onPick} />;
    if (row.kind === "workspace") return <WorkspaceRow key={row.value} id={row.id} index={index} current={false} onPick={onPick} />;
    return <NoProjectRow key={row.value} index={index} current={false} onPick={onPick} />;
  };

  return (
    <Command
      loop
      shouldFilter={false}
      value={value ?? (loaded && projects.length > 0 ? HOME_KEY : ADD_PROJECT_VALUE)}
      onValueChange={setValue}
      data-testid="palette"
      data-mode="projects"
      onKeyDown={(e) => {
        if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^[1-9]$/.test(e.key)) {
          const row = visible[Number(e.key) - 1];
          e.preventDefault();
          if (row) pick(row);
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
      {/* Not the scroll region itself: that is the rows' div, so Add a project stays put below it. */}
      <CommandList className="max-h-none overflow-visible">
        <div className="max-h-[min(420px,60vh/var(--cf-zoom))] scroll-py-1 overflow-x-hidden overflow-y-auto" data-testid="picker-rows">
          <CommandEmpty>{!loaded ? "Loading projects…" : "No matching projects."}</CommandEmpty>
          {visible.length > 0 && <div className="p-1">{visible.map(rowFor)}</div>}
        </div>
        {/* The way to a project that is not listed yet: the Add Project dialog (project.add). */}
        <div className="border-t p-1">
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
            <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-cf-text-muted">
              <FolderPlus className="size-4" />
            </span>
            <span className="truncate font-medium">Add a project…</span>
            <span className="truncate text-caption">a folder on this Mac, or from GitHub</span>
          </CommandItem>
        </div>
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
