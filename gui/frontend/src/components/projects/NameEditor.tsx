import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Input } from "@/components/ui/input";
import { workspaceNameError } from "@/lib/workspaceCard";
import { renameWorkspace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * A workspace's name on its page's header, edited in place (the header's Rename…): Enter (or leaving the field) renames
 * (workspace.rename, once), Escape keeps the stored name. Until the user types, the field
 * follows the stored name (a rename from elsewhere shows up, and an untouched field never
 * renames); once they have typed, Enter commits theirs (last write wins). Names are unique
 * whatever their case; the daemon says so too. Keys stay in the field (the page's list
 * must not move meanwhile).
 *
 * Enter and Escape settle the edit before giving the keyboard back to the page's list:
 * moving focus blurs the field synchronously, and the blur must not rename again (or, after
 * Escape, at all).
 */
export function WorkspaceNameEditor({ workspaceId, name, onDone }: { workspaceId: string; name: string; onDone: () => void }) {
  /** What the user typed; null while they have not (the field shows the stored name). */
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const others = useWorkspacesStore(useShallow((s) => s.order.filter((x) => x !== workspaceId).map((x) => s.byId[x]?.name ?? "")));
  const value = draft ?? name;
  const changed = draft !== null && draft.trim() !== name;
  const error = changed ? workspaceNameError(value, others) : "";

  /** Ends the edit once: renames when asked to and the name changed and is valid. */
  const settle = (rename: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (rename && changed && !error) void renameWorkspace(workspaceId, value);
    onDone();
  };
  const backToList = () => {
    inputRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
  };

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Input
        ref={inputRef}
        autoFocus
        value={value}
        aria-label="Workspace name"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid="workspace-name-input"
        className="h-6 w-48 px-1.5 text-body font-medium"
        onFocus={(e) => {
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onClick={(e) => {
          e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            settle(false);
            backToList();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (error) return;
            settle(true);
            backToList();
          }
        }}
        onBlur={() => {
          // Leaving the field renames like Enter; a refused name is dropped.
          settle(!error);
        }}
      />
      {error && (
        <span className="truncate text-caption text-cf-error-text" data-testid="workspace-name-error">
          {error}
        </span>
      )}
    </span>
  );
}
