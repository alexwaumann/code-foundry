import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * A name edited in place (a workspace's or a project's, on its page's header or an index row): Enter (or leaving
 * the field) renames (onRename, once), Escape keeps the stored name. Until the user types, the field
 * follows the stored name (a rename from elsewhere shows up, and an untouched field never
 * renames); once they have typed, Enter commits theirs (last write wins). `validate` says why a
 * typed name is refused ("" when fine); the daemon says so too. Keys stay in the field (the page's list
 * must not move meanwhile). WorkspaceNameEditor and ProjectNameEditor bind it to their store and command.
 *
 * Enter and Escape settle the edit before giving the keyboard back to the page's list:
 * moving focus blurs the field synchronously, and the blur must not rename again (or, after
 * Escape, at all).
 */
export function NameEditor({
  name,
  validate,
  onRename,
  onDone,
  label,
  testId,
}: {
  /** The stored name. */
  name: string;
  validate: (value: string) => string;
  onRename: (value: string) => void;
  onDone: () => void;
  /** The field's accessible name ("Workspace name"). */
  label: string;
  /** The field is `${testId}-input`, the refusal `${testId}-error`. */
  testId: string;
}) {
  /** What the user typed; null while they have not (the field shows the stored name). */
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const value = draft ?? name;
  const changed = draft !== null && draft.trim() !== name;
  const error = changed ? validate(value) : "";

  /** Ends the edit once: renames when asked to and the name changed and is valid. */
  const settle = (rename: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (rename && changed && !error) onRename(value);
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
        aria-label={label}
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid={`${testId}-input`}
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
        <span className="truncate text-caption text-cf-error-text" data-testid={`${testId}-error`}>
          {error}
        </span>
      )}
    </span>
  );
}
