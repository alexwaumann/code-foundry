import { Folder, FolderGit2, FolderOpen } from "lucide-react";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import type { PathListingState } from "./usePathListing";

// Shared by the palette's path prompts and the Add Project dialog; the keys and the
// listing come from usePathCompletion (usePathListing.ts).


/** The folder picker button beside a path input (only with the Wails host). */
export function PickFolderButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      title="Choose folder…"
      aria-label="Choose folder"
      data-testid="pick-directory"
      onClick={onClick}
    >
      <FolderOpen className="size-4" />
    </button>
  );
}

/**
 * The listing's message (a refused prefix, an outdated daemon) and its folders, as cmdk
 * items. Picking one hands its name to onPick.
 */
export function PathSuggestions({ paths, onPick }: { paths: PathListingState | null; onPick: (name: string) => void }) {
  return (
    <>
      {paths?.message && (
        <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="path-message">
          {paths.message}
        </div>
      )}
      {paths?.listing && paths.listing.entries.length > 0 && (
        <CommandGroup heading={paths.listing.truncated ? `Folders (first ${String(paths.listing.entries.length)})` : "Folders"}>
          {paths.listing.entries.map((e) => (
            <CommandItem
              key={e.path}
              value={`dir:${e.path}`}
              data-entry-name={e.name}
              data-testid="path-entry"
              data-git={e.isGit ? "true" : undefined}
              data-registered={e.registered ? "true" : undefined}
              onSelect={() => {
                onPick(e.name);
              }}
            >
              {e.isGit ? <FolderGit2 className="text-orange-600 dark:text-orange-400" aria-label="git repository" /> : <Folder />}
              <span className="truncate font-mono">{e.name}</span>
              {e.registered && <span className="ml-auto shrink-0 text-xs text-muted-foreground">already added</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
