import { useRef, useState } from "react";
import { ProjectRowGroups } from "./ProjectRows";
import { useProjectRows } from "./useProjectRows";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { draftKey, HOME_KEY, type ComposeTarget } from "@/lib/compose";
import { pickDraftWorkspace, switchDraftTarget, toggleDraftProject } from "@/stores/compose";
import { useUiStore } from "@/stores/ui";

/**
 * The composer heading's name (the workspace's, the project's, or "N projects") as a
 * button that opens the project set picker: a multi-select over the same rows as cmd+N's
 * picker, grouped (ProjectRowGroups: workspaces, projects, "No project" last). A workspace row makes its members the set and
 * the thread's reference (picked again, it drops the reference); a project row toggles
 * that project; both keep the popover open, and the rows of the set are checked. "No
 * project" moves the draft to the no-project composer (stores/compose switchDraftTarget)
 * and closes; on the no-project composer any row moves it to that target. A dotted
 * underline only; a composer Tab stop before the chips.
 *
 * Esc closes it and focus returns to the name; after a move the prompt has focus.
 */
export function ProjectSwitcher({
  target,
  name,
  set,
  disabled,
}: {
  target: ComposeTarget;
  name: string;
  /** The draft's set: its rows are checked. */
  set: { projectIds: readonly string[]; workspaceId: string };
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Controlled so every opening starts unfiltered.
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A move focuses the new composer's prompt; the popover must not hand focus back to the trigger.
  const moved = useRef(false);
  const { workspaces, projects, loaded } = useProjectRows();
  const home = target.kind === "home";

  const move = (to: ComposeTarget) => {
    moved.current = true;
    setOpen(false);
    void switchDraftTarget(target, to).then((ok) => {
      if (!ok) useUiStore.getState().focusComposer();
    });
  };
  const checked = (value: string) => {
    if (home) return value === HOME_KEY;
    if (value === HOME_KEY) return false;
    if (set.workspaceId && value === draftKey({ kind: "workspace", workspaceId: set.workspaceId })) return true;
    return set.projectIds.includes(value);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setQuery("");
          moved.current = false;
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Change projects"
          aria-haspopup="dialog"
          data-compose-stop
          data-testid="composer-project-trigger"
          // The underline is on the inline span: the button's box is the heading's line
          // height, so a border on it would float below the descenders.
          className="group cursor-pointer rounded-sm text-cf-text outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:cursor-default"
        >
          {/* The popover centres on the name itself, whatever box the button gets. */}
          <PopoverAnchor asChild>
            <span
              className="border-b-[1.5px] border-dotted border-cf-text/45 transition-colors group-hover:border-cf-text group-disabled:border-cf-text/45 group-data-[state=open]:border-cf-text"
              data-testid="composer-project-name"
            >
              {name}
            </span>
          </PopoverAnchor>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        sideOffset={8}
        className="w-80 p-0 text-left text-body tracking-normal"
        data-testid="composer-project-list"
        onOpenAutoFocus={(e) => {
          // cmdk handles keys on its input: focus that, not the popover.
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (moved.current) e.preventDefault();
        }}
      >
        <Command loop label="Projects of the thread" className="rounded-lg outline-hidden">
          <CommandInput ref={inputRef} placeholder="Add or remove projects…" aria-label="Filter projects" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-80">
            <CommandEmpty>{loaded ? "No matching projects." : "Loading projects…"}</CommandEmpty>
            <ProjectRowGroups
              workspaces={workspaces}
              projects={projects}
              checked={checked}
              onPickProject={(projectId) => {
                if (home) move({ kind: "project", projectId });
                else void toggleDraftProject(target, projectId);
              }}
              onPickWorkspace={(workspaceId) => {
                if (home) move({ kind: "workspace", workspaceId });
                else void pickDraftWorkspace(target, workspaceId);
              }}
              onPickNoProject={
                loaded
                  ? () => {
                      if (home) setOpen(false);
                      else move({ kind: "home" });
                    }
                  : undefined
              }
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
