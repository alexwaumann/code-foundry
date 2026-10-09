import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { formatChord } from "@/keys/chord";
import { projectHue, projectInitials } from "@/lib/compose";
import { tildify } from "@/lib/path";
import { composeIn } from "@/stores/compose";
import { getUiContext } from "@/stores/context";
import { useReposStore } from "@/stores/repos";
import { useUiStore } from "@/stores/ui";

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
  return (
    <CommandItem
      value={id}
      keywords={[name, path]}
      onSelect={() => {
        onPick(id);
      }}
      data-project={id}
      className="gap-3 py-2"
    >
      <ProjectBadge name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">Local · {tildify(path)}</span>
      </span>
      {index < 9 && <CommandShortcut>{formatChord(`cmd+${String(index + 1)}`)}</CommandShortcut>}
    </CommandItem>
  );
}

const hints = [
  ["↑↓", "Navigate"],
  ["Enter", "Select"],
  ["Backspace", "Back"],
  ["Esc", "Close"],
] as const;

/**
 * The palette's project picker: session.new's presentation in the GUI. Picking a project
 * opens the new-thread composer for it. The project in the current context (if any) is
 * highlighted first; cmd+1..9 pick by position.
 */
export function ProjectPicker({ close }: { close: () => void }) {
  const order = useReposStore(useShallow((s) => s.order));
  const loaded = useReposStore((s) => s.loaded);
  // Highlight the project the user was looking at when the picker opened.
  const [initial] = useState(() => {
    const id = getUiContext().activeRepoId;
    return id && useReposStore.getState().byId[id] ? id : undefined;
  });
  const [query, setQuery] = useState("");

  const pick = (id: string) => {
    // The composer takes focus, not whatever had it before the picker opened.
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "content" } }));
    close();
    composeIn(id);
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
      <CommandInput autoFocus value={query} onValueChange={setQuery} placeholder="Search projects…" aria-label="Search projects" />
      <CommandList>
        <CommandEmpty>{!loaded ? "Loading projects…" : order.length === 0 ? "No repositories registered. Register one with Register Repository." : "No matching projects."}</CommandEmpty>
        {order.length > 0 && (
          <CommandGroup heading="New thread in…">
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
