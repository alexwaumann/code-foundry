import { useRef } from "react";
import { ChevronRight, Folder, FolderGit2, FolderOpen } from "lucide-react";
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
 * items. Enter on one hands its name to onPick. A click does too, unless onOpen is given:
 * then a click hands it to onOpen (the caller opens the folder) and each row shows a
 * chevron while hovered or highlighted. The palette passes only onPick; the Add Project
 * dialog passes both.
 */
export function PathSuggestions({
  paths,
  onPick,
  onOpen,
}: {
  paths: PathListingState | null;
  onPick: (name: string) => void;
  onOpen?: (name: string) => void;
}) {
  // cmdk runs onSelect for a click and for Enter alike. A click's capture phase runs on
  // the row before cmdk's own onClick (the same event), so it marks the select as a click.
  const clicked = useRef(false);
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
              className={onOpen ? "group" : undefined}
              data-entry-name={e.name}
              data-testid="path-entry"
              data-git={e.isGit ? "true" : undefined}
              data-registered={e.registered ? "true" : undefined}
              onClickCapture={
                onOpen
                  ? () => {
                      clicked.current = true;
                    }
                  : undefined
              }
              onSelect={() => {
                const click = clicked.current;
                clicked.current = false;
                if (click && onOpen) onOpen(e.name);
                else onPick(e.name);
              }}
            >
              {e.isGit ? <FolderGit2 className="text-orange-600 dark:text-orange-400" aria-label="git repository" /> : <Folder />}
              <span className="truncate font-mono">{e.name}</span>
              {e.registered && <span className="ml-auto shrink-0 text-xs text-muted-foreground">already added</span>}
              {onOpen && (
                <ChevronRight
                  className={`${e.registered ? "" : "ml-auto "}text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100`}
                  aria-hidden
                  data-testid="path-entry-open"
                />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
