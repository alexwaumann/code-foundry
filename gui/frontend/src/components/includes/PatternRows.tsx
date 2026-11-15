import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/tooltip";
import { typedPattern } from "@/lib/includePatterns";
import { cn } from "@/lib/utils";

export const ADD_PLACEHOLDER = "Add a pattern, like *.local.json or scratch/";

/** A quiet tag after a pattern: where it comes from ("default", "all projects"). */
export function PatternBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-cf-border px-1 text-caption-sm text-cf-text-muted" data-testid="include-badge">
      {children}
    </span>
  );
}

/** One pattern: monospace, its badge, and × at the right. */
export function PatternRow({ pattern, badge, scope, disabled, onRemove, className }: { pattern: string; badge?: ReactNode; scope?: string; disabled: boolean; onRemove: () => void; className?: string }) {
  return (
    <div className={cn("flex min-h-9 items-center gap-2.5 px-3 py-1", className)} data-testid="include-row" data-pattern={pattern} data-scope={scope}>
      <code className="min-w-0 truncate text-code text-cf-text">{pattern}</code>
      {badge !== undefined && <PatternBadge>{badge}</PatternBadge>}
      <Tip label="Remove">
        <Button type="button" variant="ghost" size="icon-xs" className="ml-auto text-cf-text-muted" aria-label={`Remove ${pattern}`} disabled={disabled} data-testid="include-remove" onClick={onRemove}>
          <X />
        </Button>
      </Tip>
    </div>
  );
}

/** The daemon's (or the field's) message about a pattern, under the list. */
export function PatternError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p className={cn("text-caption break-words text-cf-error-text", className)} role="alert" data-testid="include-error">
      {message}
    </p>
  );
}

/**
 * The add field at the bottom of a list (the settings' list: no suggestions). Enter adds the
 * typed pattern; it is cleared once added and kept with the message when refused. Escape
 * clears it and blurs (the settings sheet's next Escape closes it). While `busy` (a save is out) Enter waits: the field stays enabled so it keeps
 * the keyboard.
 */
export function AddPatternInput({ onAdd, busy, onError, className }: { onAdd: (pattern: string) => Promise<string | null>; busy: boolean; onError: (message: string | null) => void; className?: string }) {
  const [text, setText] = useState("");
  return (
    <div className={cn("bg-cf-surface-sunken px-3 py-2", className)}>
      <Input
        value={text}
        aria-label="Add a pattern"
        placeholder={ADD_PLACEHOLDER}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="h-7 text-code"
        data-testid="include-add-input"
        onChange={(e) => {
          setText(e.target.value);
          onError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Like a text setting: clears and lets go, so the next Escape closes the sheet.
            e.preventDefault();
            e.stopPropagation();
            setText("");
            onError(null);
            e.currentTarget.blur();
            return;
          }
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (busy) return;
          const { pattern, error } = typedPattern(text);
          if (error) {
            onError(error);
            return;
          }
          if (pattern === "") return;
          void onAdd(pattern).then((err) => {
            onError(err);
            if (err === null) setText("");
          });
        }}
      />
    </div>
  );
}
