import { useEffect, useRef } from "react";
import { FindBarView, type FindBarCommands } from "@/components/find/FindBarView";
import { countLabel, matchIndex, type FindMatch } from "@/lib/threadFind";
import { cn } from "@/lib/utils";
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

const COMMANDS: FindBarCommands = { find: "thread.find", next: "thread.find.next", previous: "thread.find.previous" };

const NO_MATCHES: readonly FindMatch[] = [];

/**
 * The in-thread find bar (thread.find, docs/notes/search-2-thread-find.md): at the top of
 * the thread body's right column, where the thread info card starts (the card moves down
 * under it), or in the same spot over the conversation when the card is closed. What is in
 * it is FindBarView's; Escape closes and clears, and gives the keyboard to the prompt.
 */
export function FindBar({ threadId, narrow = false }: { threadId: string; narrow?: boolean }) {
  const open = useThreadFindOpen(threadId);
  return open ? <Bar threadId={threadId} narrow={narrow} /> : null;
}

function Bar({ threadId, narrow }: { threadId: string; narrow: boolean }) {
  const query = useThreadFindQuery(threadId);
  const focusSeq = useThreadFindFocusSeq(threadId);
  const matches = useThreadFindMatches(threadId, query) ?? NO_MATCHES;
  const current = useThreadFindCurrent(threadId);
  const index = matchIndex(matches, current);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);
  return (
    <FindBarView
      className={cn("top-3 right-[calc(var(--ti-gutter)-var(--ti-inset)-var(--timeline-sb,0px))]", narrow ? "w-77" : "w-[calc(var(--ti-card)-var(--ti-gutter))]")}
      label="Find in thread"
      testId="thread-find"
      query={query}
      count={countLabel(query, index, matches.length)}
      canStep={matches.length > 0}
      commands={COMMANDS}
      inputRef={inputRef}
      onQuery={(q) => {
        setThreadFindQuery(threadId, q);
      }}
      onStep={(dir) => void stepThreadFind(threadId, dir)}
      onClose={() => {
        closeThreadFind(threadId);
        // The keyboard goes back to the thread's prompt, as Escape in the composer leaves it there.
        useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
      }}
    />
  );
}
