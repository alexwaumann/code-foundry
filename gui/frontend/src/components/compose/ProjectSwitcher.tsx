import { useRef, useState } from "react";
import { ProjectRowGroups } from "./ProjectRows";
import { useProjectRows } from "./useProjectRows";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { draftKey, HOME_KEY, type ComposeTarget } from "@/lib/compose";
import { pickDraftWorkspace, setDraftProject, switchDraftTarget } from "@/stores/compose";
import { useUiStore } from "@/stores/ui";

/**
 * The composer heading's name (the workspace's, the project's, or "N projects") as a
 * button that opens the project picker: a single pick over the same rows as cmd+N's
 * picker, grouped (ProjectRowGroups: workspaces, projects, "No project" last). A workspace
 * row makes its members the set and the thread's reference; a project row makes that
 * project the whole set (no workspace); "No project" moves the draft to the no-project
 * composer (stores/compose switchDraftTarget), and on the no-project composer any row
 * moves it to that target. The row of the current target is checked: the referenced
 * workspace, or a lone project. Adding to the set is the chip row's "Add project".
 *
 * Every pick closes the list; it, Esc and a click away all hand focus to the prompt. A
 * dotted underline only; a composer Tab stop before the chips.
 */
export function ProjectSwitcher({
  target,
  name,
  set,
  disabled,
  focusPrompt,
}: {
  target: ComposeTarget;
  name: string;
  /** The draft's set: the row it names is checked. */
  set: { projectIds: readonly string[]; workspaceId: string };
  disabled: boolean;
  /**
   * Focuses the prompt now (not a frame later: a deferred focus can land after the next
   * popover opened and close it as a focus outside). A move to another composer uses
   * stores/ui focusComposer, which the new composer answers on mount.
   */
  focusPrompt: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Controlled so every opening starts unfiltered.
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { workspaces, projects, loaded } = useProjectRows();
  const home = target.kind === "home";

  const move = (to: ComposeTarget) => {
    setOpen(false);
    void switchDraftTarget(target, to).then((ok) => {
      if (ok) useUiStore.getState().focusComposer();
      else focusPrompt();
    });
  };
  const pick = (write: Promise<boolean>) => {
    setOpen(false);
    void write.then(focusPrompt);
  };
  const checked = (value: string) => {
    if (home) return value === HOME_KEY;
    if (set.workspaceId) return value === draftKey({ kind: "workspace", workspaceId: set.workspaceId });
    return set.projectIds.length === 1 && value === set.projectIds[0];
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setQuery("");
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
              className="border-b-[1.5px] border-dotted border-cf-text/45 font-semibold transition-colors group-hover:border-cf-text group-disabled:border-cf-text/45 group-data-[state=open]:border-cf-text"
              data-testid="composer-project-name"
            >
              {name}
            </span>
          </PopoverAnchor>
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
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
          // The prompt, never the heading: after a pick, Esc or a click away alike. This
          // runs after the exit animation: not when another control (Add project's list)
          // has the keyboard by then, or it would close as a focus outside.
          e.preventDefault();
          const el = document.activeElement;
          if (!el || el === document.body || contentRef.current?.contains(el)) focusPrompt();
        }}
      >
        <Command loop label="Projects of the thread" className="rounded-lg outline-hidden">
          <CommandInput ref={inputRef} placeholder="Switch to a workspace or project…" aria-label="Filter projects" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-80">
            <CommandEmpty>{loaded ? "No matching projects." : "Loading projects…"}</CommandEmpty>
            <ProjectRowGroups
              workspaces={workspaces}
              projects={projects}
              checked={checked}
              onPickProject={(projectId) => {
                if (home) move({ kind: "project", projectId });
                else pick(setDraftProject(target, projectId));
              }}
              onPickWorkspace={(workspaceId) => {
                if (home) move({ kind: "workspace", workspaceId });
                else pick(pickDraftWorkspace(target, workspaceId));
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
