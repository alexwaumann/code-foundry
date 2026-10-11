import { useRef, useState } from "react";
import { ProjectRowGroups } from "./ProjectRows";
import { useProjectRows } from "./useProjectRows";
import { Command, CommandEmpty, CommandInput, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { draftKey, type ComposeTarget } from "@/lib/compose";
import { switchDraftTarget } from "@/stores/compose";
import { useUiStore } from "@/stores/ui";

/**
 * The composer heading's project or workspace name, as a button that switches the
 * composer to another one and moves the draft along (stores/compose switchDraftTarget).
 * A dotted underline only; a composer Tab stop before the member chips. The popover
 * lists the same rows as cmd+N's picker (ProjectRows) without the cmd+1..9 hints, the
 * current target checked and highlighted first.
 *
 * Esc closes it and focus returns to the name; after a pick the prompt has focus (the
 * new composer's, or this one's when nothing moved: the same target, or a cancelled
 * replace).
 */
export function ProjectSwitcher({ target, name, disabled }: { target: ComposeTarget; name: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  // Controlled so every opening starts unfiltered.
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // A pick moves focus to the prompt; the popover must not hand it back to the trigger.
  const picked = useRef(false);
  const { workspaces, projects, loaded } = useProjectRows();
  const current = draftKey(target);

  const pick = (to: ComposeTarget) => {
    picked.current = true;
    setOpen(false);
    void switchDraftTarget(target, to).then((moved) => {
      if (!moved) useUiStore.getState().focusComposer();
    });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setQuery("");
          picked.current = false;
        }
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Change project"
          aria-haspopup="dialog"
          title="Change project"
          data-compose-stop
          data-testid="composer-project-trigger"
          className="cursor-pointer rounded-sm border-b-[1.5px] border-dotted border-foreground/45 pb-px text-foreground outline-none transition-colors hover:border-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:hover:border-foreground/45 data-[state=open]:border-foreground"
        >
          {name}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        className="w-80 p-0 text-left text-sm font-normal tracking-normal"
        data-testid="composer-project-list"
        onOpenAutoFocus={(e) => {
          // cmdk handles keys on its input: focus that, not the popover.
          e.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
        }}
      >
        <Command loop defaultValue={current} label="Switch project" className="rounded-lg outline-hidden">
          <CommandInput ref={inputRef} placeholder="Switch project…" aria-label="Switch project" value={query} onValueChange={setQuery} />
          <CommandList className="max-h-80">
            <CommandEmpty>{loaded ? "No matching projects." : "Loading projects…"}</CommandEmpty>
            <ProjectRowGroups
              workspaces={workspaces}
              projects={projects}
              current={current}
              onPickProject={(repoId) => {
                pick({ kind: "project", repoId });
              }}
              onPickWorkspace={(workspaceId) => {
                pick({ kind: "workspace", workspaceId });
              }}
            />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
