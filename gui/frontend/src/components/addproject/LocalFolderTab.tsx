import { useEffect, useRef, useState } from "react";
import { FolderPlus, Loader2, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/stream";
import { PathSuggestions, PickFolderButton } from "@/components/palette/pathCompletion";
import { usePathCompletion } from "@/components/palette/usePathListing";
import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { descendInto, entryPath, HOME_PREFIX, homeDisplay, homeRelative } from "@/palette/paths";
import type { FolderInfoView } from "@/api/addProject";
import {
  addFolderAsWorkspace,
  finishAddProject,
  folderOfRepos,
  onAddProjectEscape,
  registerFolder,
  selectAddedProject,
  showAddedWorkspace,
} from "@/stores/addProject";
import { FolderChoice, type FolderChoiceBusy } from "./FolderChoice";

/**
 * cmdk always highlights an item (the first, after each keystroke). This hidden one comes
 * first and stands for "no folder highlighted": Enter on it adds the typed path.
 */
const TYPED = "__typed";

/**
 * Local folder: a path under home with the palette's folder completion (Tab, `/`, the
 * folder picker), added with ProjectService.Register. The input's "~/" is permanent: what is
 * typed, pasted or picked is taken relative to home (homeRelative). A git repository adds
 * that repository, any other folder a project without git.
 *
 * A click on a folder (or Tab, or `/` on the highlighted one) opens it; only Enter and the
 * Add project button add. Enter adds the highlighted folder, else the typed path.
 *
 * A folder that is not a git repository but has git repositories directly inside it is
 * not added at once: the tab asks how (FolderChoice), as a workspace of those
 * repositories (project.add-workspace) or as one plain project. Editing the path drops
 * the question.
 */
export function LocalFolderTab({ active }: { active: boolean }) {
  const [path, setPath] = useState(HOME_PREFIX);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The folder of repos being asked about (with the path as typed), else null. */
  const [choice, setChoice] = useState<{ typed: string; folder: FolderInfoView } | null>(null);
  const [choiceBusy, setChoiceBusy] = useState<FolderChoiceBusy>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Focus the path when the tab is shown (a click on the tab, or the dialog opening,
  // focuses something else first).
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      rootRef.current?.querySelector("input")?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [active]);

  const change = (v: string) => {
    setPath(homeRelative(v));
    setError(null);
    setChoice(null);
  };
  const { paths, host, handleKey, chooseFolder } = usePathCompletion({
    query: path,
    enabled: !busy && !choice,
    rootRef,
    replace: (from, next) => {
      setPath((cur) => (cur === from ? homeRelative(next) : cur));
      setError(null);
      setChoice(null);
    },
  });

  const submit = async (value: string) => {
    const p = homeRelative(value.trim());
    if (homeDisplay(p) === "" || busy) {
      if (homeDisplay(p) === "") setError("Type a folder path, or pick one.");
      return;
    }
    setBusy(true);
    setError(null);
    const folder = await folderOfRepos(p);
    if (folder) {
      setPath(p);
      setChoice({ typed: p, folder });
      setBusy(false);
      return;
    }
    try {
      const project = await registerFolder(p);
      toast.success(`Added ${project.name}`);
      finishAddProject();
      selectAddedProject(project.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const addChosen = async (as: "workspace" | "project") => {
    if (!choice || choiceBusy) return;
    setChoiceBusy(as);
    setError(null);
    try {
      if (as === "workspace") {
        const w = await addFolderAsWorkspace(choice.typed);
        toast.success(`Added workspace ${w.name}`);
        finishAddProject();
        showAddedWorkspace(w.id);
      } else {
        const project = await registerFolder(choice.typed);
        toast.success(`Added ${project.name}`);
        finishAddProject();
        selectAddedProject(project.id);
      }
    } catch (err) {
      setError(errorMessage(err));
      setChoiceBusy(null);
    }
  };

  const focusInput = () => {
    rootRef.current?.querySelector("input")?.focus();
  };

  // Escape on the two choices goes back to the path (as typed), not out of the dialog.
  const asking = choice !== null && choiceBusy === null;
  useEffect(() => {
    if (!asking) return;
    return onAddProjectEscape(() => {
      setChoice(null);
      setError(null);
      rootRef.current?.querySelector("input")?.focus();
    });
  }, [asking]);

  const open = (name: string) => {
    setPath(homeRelative(descendInto(path, name)));
    setError(null);
    focusInput();
  };

  const pickFolder = async () => {
    try {
      const picked = await chooseFolder();
      if (picked) change(picked);
    } catch (err) {
      setError(errorMessage(err));
    }
    focusInput();
  };

  const typed = homeDisplay(path);
  return (
    <div className="flex flex-col gap-3" data-testid="add-project-local">
      <p className="text-caption">
        A folder under your home directory. A git repository is added with its worktrees; any other folder becomes a project without git.
      </p>
      <Command
        ref={rootRef}
        shouldFilter={false}
        loop
        defaultValue={TYPED}
        className="rounded-md border"
        onKeyDown={(e) => {
          handleKey(e);
        }}
      >
        <CommandInput
          value={typed}
          onValueChange={change}
          disabled={busy || choiceBusy !== null}
          placeholder="path/to/folder"
          aria-label="Folder path under your home directory"
          className="-ml-2 font-mono"
          data-testid="add-project-local-input"
          data-path={path}
          leading={
            <>
              <SearchIcon className="size-4 shrink-0 opacity-50" aria-hidden />
              <span className="shrink-0 text-body font-mono text-cf-text-muted select-none" aria-hidden data-testid="add-project-local-prefix">
                {HOME_PREFIX}
              </span>
            </>
          }
          trailing={
            host ? (
              <PickFolderButton
                onClick={() => {
                  void pickFolder();
                }}
              />
            ) : undefined
          }
        />
        <CommandList className={choice ? "hidden" : "max-h-64"}>
          <CommandItem
            value={TYPED}
            className="hidden"
            data-testid="add-project-local-typed"
            onSelect={() => {
              void submit(path);
            }}
          />
          <PathSuggestions
            paths={paths}
            onPick={(name) => {
              void submit(entryPath(path, name));
            }}
            onOpen={open}
          />
        </CommandList>
      </Command>
      {choice ? (
        <FolderChoice
          path={choice.typed}
          repos={choice.folder.childRepos.length}
          busy={choiceBusy}
          error={error}
          onWorkspace={() => void addChosen("workspace")}
          onProject={() => void addChosen("project")}
        />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className={`text-caption ${error ? "text-cf-error-text" : "text-cf-text-muted"}`} role={error ? "alert" : undefined} data-testid="add-project-local-message">
            {error ?? "Click or Tab opens a folder · Enter adds"}
          </span>
          <Button type="button" size="sm" disabled={busy || typed === ""} onClick={() => void submit(path)} data-testid="add-project-local-submit">
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FolderPlus aria-hidden />}
            Add project
          </Button>
        </div>
      )}
    </div>
  );
}
