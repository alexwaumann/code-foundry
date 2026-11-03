import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { caseSensitive, countLabel, matchIndex } from "@/lib/threadFind";
import { cn } from "@/lib/utils";
import { chordFromEvent, normalizeChord } from "@/keys/chord";
import { useCommandsStore } from "@/stores/commands";
import { useUiStore } from "@/stores/ui";
import {
  closeThreadFind,
  setThreadFindQuery,
  stepThreadFind,
  useThreadFindCurrent,
  useThreadFindFocusSeq,
  useThreadFindMatches,
  useThreadFindOpen,
  useThreadFindQuery,
} from "@/stores/threadFind";

/** The find verbs whose chords also work while the bar's field has the keyboard. */
const BAR_COMMANDS: Readonly<Record<string, (threadId: string) => void>> = {
  "thread.find": () => undefined,
  "thread.find.next": (id) => void stepThreadFind(id, 1),
  "thread.find.previous": (id) => void stepThreadFind(id, -1),
};

/** The command a chord is bound to, of the find verbs (the user's bindings, as the keymap has them). */
function barCommand(e: KeyboardEvent): string | undefined {
  const chord = chordFromEvent(e.nativeEvent);
  if (!chord) return undefined;
  return useCommandsStore.getState().commands.find((c) => c.name in BAR_COMMANDS && c.keybindings.some((k) => normalizeChord(k) === chord))?.name;
}

/**
 * The in-thread find bar (thread.find, docs/notes/search-2-thread-find.md): at the top of
 * the thread body's right column, where the thread info card starts (the card moves down
 * under it), or in the same spot over the conversation when the card is closed. The
 * query, then "Aa" while the search is case-sensitive (smart case: a capital letter in
 * the query), the count, previous, next and close. Enter and shift+Enter step, Escape
 * closes and clears; the find verbs' chords work in its field.
 */
export function FindBar({ threadId, narrow = false }: { threadId: string; narrow?: boolean }) {
  const open = useThreadFindOpen(threadId);
  return open ? <Bar threadId={threadId} narrow={narrow} /> : null;
}

function Bar({ threadId, narrow }: { threadId: string; narrow: boolean }) {
  const query = useThreadFindQuery(threadId);
  const focusSeq = useThreadFindFocusSeq(threadId);
  const matches = useThreadFindMatches(threadId, query);
  const current = useThreadFindCurrent(threadId);
  const index = matchIndex(matches, current);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);
  const close = () => {
    closeThreadFind(threadId);
    // The keyboard goes back to the thread's prompt, as Escape in the composer leaves it there.
    useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void stepThreadFind(threadId, e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const name = barCommand(e);
    if (name === "thread.find") {
      e.preventDefault();
      inputRef.current?.select();
    } else if (name) {
      e.preventDefault();
      BAR_COMMANDS[name]?.(threadId);
    }
  };
  const some = matches.length > 0;
  return (
    <div
      className={cn(
        "pointer-events-auto absolute top-3 right-[calc(var(--ti-gutter)-var(--ti-inset)-var(--timeline-sb,0px))] flex h-9.5 items-center gap-1 rounded-lg border bg-cf-surface-overlay py-1 pr-1 pl-3 shadow-2xl",
        narrow ? "w-77" : "w-[calc(var(--ti-card)-var(--ti-gutter))]",
      )}
      role="search"
      aria-label="Find in thread"
      data-keys-local
      data-testid="thread-find"
    >
      <input
        ref={inputRef}
        className="min-w-0 flex-1 bg-transparent text-body-sm text-cf-text outline-none placeholder:text-cf-placeholder"
        placeholder="Find in thread"
        aria-label="Find in thread"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(e) => {
          setThreadFindQuery(threadId, e.target.value);
        }}
        onKeyDown={onKeyDown}
        data-testid="thread-find-input"
      />
      {caseSensitive(query) && (
        <Tip label="Case-sensitive: the query has a capital letter">
          <span className="rounded-sm bg-cf-accent-surface px-1.5 text-caption-sm text-cf-accent-surface-foreground" data-testid="thread-find-case">
            Aa
          </span>
        </Tip>
      )}
      {query !== "" && (
        <span className="mx-1 shrink-0 text-caption text-cf-text-muted tabular-nums" aria-live="polite" data-testid="thread-find-count">
          {countLabel(query, index, matches.length)}
        </span>
      )}
      <StepButton label="Previous match" disabled={!some} onClick={() => void stepThreadFind(threadId, -1)} testId="thread-find-prev">
        <ChevronUp aria-hidden />
      </StepButton>
      <StepButton label="Next match" disabled={!some} onClick={() => void stepThreadFind(threadId, 1)} testId="thread-find-next">
        <ChevronDown aria-hidden />
      </StepButton>
      <StepButton label="Close find" onClick={close} testId="thread-find-close">
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
