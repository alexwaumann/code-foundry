import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, FolderPlus, Loader2, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/stream";
import { PathSuggestions, PickFolderButton } from "@/components/palette/pathCompletion";
import { usePathCompletion } from "@/components/palette/usePathListing";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { entryPath, HOME_PREFIX, homeDisplay, homeRelative } from "@/palette/paths";
import { finishAddProject, registerFolder, selectAddedProject } from "@/stores/addProject";

/**
 * Local folder: a path under home with the palette's folder completion (Tab, `/`, the
 * folder picker), added with RepoService.Register. The input's "~/" is permanent: what is
 * typed, pasted or picked is taken relative to home (homeRelative). A git repository adds
 * that repository, any other folder a project without git.
 */
export function LocalFolderTab({ active }: { active: boolean }) {
  const [path, setPath] = useState(HOME_PREFIX);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  };
  const { paths, host, handleKey, chooseFolder } = usePathCompletion({
    query: path,
    enabled: !busy,
    rootRef,
    replace: (from, next) => {
      setPath((cur) => (cur === from ? homeRelative(next) : cur));
      setError(null);
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
    try {
      const repo = await registerFolder(p);
      toast.success(`Added ${repo.name}`);
      finishAddProject();
      selectAddedProject(repo.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    try {
      const picked = await chooseFolder();
      if (picked) change(picked);
    } catch (err) {
      setError(errorMessage(err));
    }
    rootRef.current?.querySelector("input")?.focus();
  };

  const typed = homeDisplay(path);
  return (
    <div className="flex flex-col gap-3" data-testid="add-project-local">
      <p className="text-xs text-muted-foreground">
        A folder under your home directory. A git repository is added with its worktrees; any other folder becomes a project without git.
      </p>
      <Command
        ref={rootRef}
        shouldFilter={false}
        loop
        defaultValue="__submit"
        className="rounded-md border"
        onKeyDown={(e) => {
          handleKey(e);
        }}
      >
        <CommandInput
          value={typed}
          onValueChange={change}
          disabled={busy}
          placeholder="path/to/folder"
          aria-label="Folder path under your home directory"
          className="-ml-2 font-mono"
          data-testid="add-project-local-input"
          data-path={path}
          leading={
            <>
              <SearchIcon className="size-4 shrink-0 opacity-50" aria-hidden />
              <span className="shrink-0 font-mono text-sm text-muted-foreground select-none" aria-hidden data-testid="add-project-local-prefix">
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
        <CommandList className="max-h-64">
          <CommandGroup>
            <CommandItem
              value="__submit"
              onSelect={() => {
                void submit(path);
              }}
            >
              <CornerDownLeft />
              {typed ? (
                <span className="truncate">
                  Add <span className="font-mono">{path}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">Type a path; Tab completes</span>
              )}
            </CommandItem>
          </CommandGroup>
          <PathSuggestions
            paths={paths}
            onPick={(name) => {
              void submit(entryPath(path, name));
            }}
          />
        </CommandList>
      </Command>
      <div className="flex items-center justify-between gap-3">
        <span className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`} role={error ? "alert" : undefined} data-testid="add-project-local-message">
          {error ?? "Tab completes · / opens the highlighted folder · Enter adds"}
        </span>
        <Button type="button" size="sm" disabled={busy || typed === ""} onClick={() => void submit(path)} data-testid="add-project-local-submit">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <FolderPlus aria-hidden />}
          Add project
        </Button>
      </div>
    </div>
  );
}
