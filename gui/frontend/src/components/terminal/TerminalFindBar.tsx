import { useEffect, useRef } from "react";
import { FindBarView, type FindBarCommands } from "@/components/find/FindBarView";
import { closeTerminalFind, setTerminalFindQuery, stepTerminalFind, terminalFindFocused, useTerminalFindFocusSeq, useTerminalFindQuery, useTerminalFindResults, useTerminalFindStore } from "@/stores/terminalFind";
import { terminalCountLabel } from "@/terminal/results";

const COMMANDS: FindBarCommands = { find: "terminal.find", next: "terminal.find.next", previous: "terminal.find.previous" };

/**
 * The terminal's find bar (terminal.find, docs/notes/terminal-find.md): floating at the top
 * right of the terminal. What is in it is FindBarView's; Escape closes and clears, and
 * `onClosed` gives the keyboard back to xterm. Typing here reaches the query, never the PTY.
 */
export function TerminalFindBar({ terminalId, onClosed }: { terminalId: string; onClosed: () => void }) {
  const query = useTerminalFindQuery(terminalId) ?? "";
  const focusSeq = useTerminalFindFocusSeq(terminalId);
  const results = useTerminalFindResults(terminalId);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Only for a new request: a bar that comes back with its tab or panel leaves the keyboard where it is.
    if (useTerminalFindStore.getState().byTerminal[terminalId]?.focusedSeq === focusSeq) return;
    terminalFindFocused(terminalId, focusSeq);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [terminalId, focusSeq]);
  return (
    <FindBarView
      className="top-2 right-3 z-10 w-80 max-w-[calc(100%-1.5rem)]"
      label="Find in terminal"
      testId="terminal-find"
      query={query}
      count={terminalCountLabel(results)}
      canStep={results.total > 0}
      commands={COMMANDS}
      inputRef={inputRef}
      onQuery={(q) => {
        setTerminalFindQuery(terminalId, q);
      }}
      onStep={(dir) => {
        stepTerminalFind(terminalId, dir);
      }}
      onClose={() => {
        closeTerminalFind(terminalId);
        onClosed();
      }}
    />
  );
}
