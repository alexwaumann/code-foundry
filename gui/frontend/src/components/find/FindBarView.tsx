import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { chordFromEvent, normalizeChord } from "@/keys/chord";
import { caseSensitive } from "@/lib/threadFind";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";

/** The find verbs of one bar, whose chords also work while its field has the keyboard. */
export interface FindBarCommands {
  find: string;
  next: string;
  previous: string;
}

/** Which of the bar's verbs a chord is bound to (the user's bindings, as the keymap has them). */
function barCommand(e: KeyboardEvent, commands: FindBarCommands): keyof FindBarCommands | undefined {
  const chord = chordFromEvent(e.nativeEvent);
  if (!chord) return undefined;
  const bound = (name: string) => useCommandsStore.getState().commands.some((c) => c.name === name && c.keybindings.some((k) => normalizeChord(k) === chord));
  return (["find", "next", "previous"] as const).find((verb) => bound(commands[verb]));
}

/**
 * The find bar both finds share (the thread's, components/thread/find/FindBar.tsx, and the
 * terminal's, components/terminal/TerminalFindBar.tsx): the query, then "Aa" while the
 * search is case-sensitive (smart case: a capital letter in the query), the count, previous,
 * next and close. Enter and shift+Enter step, Escape closes; the find verbs' chords work in
 * its field. Presentational: the caller owns the state, where the bar sits (`className`)
 * and when its field takes the keyboard (`inputRef`).
 */
export function FindBarView({
  className,
  label,
  testId,
  query,
  count,
  canStep,
  commands,
  inputRef,
  onQuery,
  onStep,
  onClose,
}: {
  className: string;
  /** "Find in thread": the field's placeholder, and the bar's and field's accessible name. */
  label: string;
  /** Prefix of the bar's test ids: `<testId>`, `<testId>-input`, `-case`, `-count`, `-prev`, `-next`, `-close`. */
  testId: string;
  query: string;
  /** "4 of 9", shown once there is a query. */
  count: string;
  /** Some match to step to: the step buttons are dimmed without one. */
  canStep: boolean;
  commands: FindBarCommands;
  inputRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const verb = barCommand(e, commands);
    if (verb === "find") {
      e.preventDefault();
      inputRef.current?.select();
    } else if (verb) {
      e.preventDefault();
      onStep(verb === "next" ? 1 : -1);
    }
  };
  return (
    <div
      className={cn("pointer-events-auto absolute flex h-9.5 items-center gap-1 rounded-lg border bg-cf-surface-overlay py-1 pr-1 pl-3 shadow-2xl", className)}
      role="search"
      aria-label={label}
      data-keys-local
      data-testid={testId}
    >
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent text-body-sm text-cf-text outline-none placeholder:text-cf-placeholder"
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
        }}
        onKeyDown={onKeyDown}
        data-testid={`${testId}-input`}
      />
      {caseSensitive(query) && (
        <Tip label="Case-sensitive: the query has a capital letter">
          <span className="rounded-sm bg-cf-accent-surface px-1.5 text-caption-sm text-cf-accent-surface-foreground" data-testid={`${testId}-case`}>
            Aa
          </span>
        </Tip>
      )}
      {query !== "" && (
        <span className="mx-1 shrink-0 text-caption text-cf-text-muted tabular-nums" aria-live="polite" data-testid={`${testId}-count`}>
          {count}
        </span>
      )}
      <StepButton
        label="Previous match"
        disabled={!canStep}
        onClick={() => {
          onStep(-1);
        }}
        testId={`${testId}-prev`}
      >
        <ChevronUp aria-hidden />
      </StepButton>
      <StepButton
        label="Next match"
        disabled={!canStep}
        onClick={() => {
          onStep(1);
        }}
        testId={`${testId}-next`}
      >
        <ChevronDown aria-hidden />
      </StepButton>
      <StepButton label="Close find" onClick={onClose} testId={`${testId}-close`}>
        <X aria-hidden />
      </StepButton>
    </div>
  );
}

/** An icon-only button of the bar; its tooltip is its name. Dimmed, not disabled, without a match, so the field keeps the keyboard. */
function StepButton({ label, disabled = false, onClick, testId, children }: { label: string; disabled?: boolean; onClick: () => void; testId: string; children: ReactNode }) {
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn("size-5.5 rounded-sm text-cf-text-muted hover:text-cf-text [&_svg:not([class*='size-'])]:size-3.5", disabled && "opacity-40")}
        aria-label={label}
        aria-disabled={disabled || undefined}
        // The field keeps the keyboard: a press does not move focus to the button.
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (!disabled) onClick();
        }}
        data-testid={testId}
      >
        {children}
      </Button>
    </Tip>
  );
}
