import { useEffect, useRef } from "react";
import { FindBarView, type FindBarCommands } from "@/components/find/FindBarView";
import { fileCountLabel } from "@/lib/fileFind";
import { fileFindFocused, finishFileFind, setFileFindQuery, stepFileFind, useFileFindCount, useFileFindFocusSeq, useFileFindQuery, useFileFindStore } from "@/stores/fileFind";

const COMMANDS: FindBarCommands = { find: "file.search", next: "file.search.next", previous: "file.search.previous" };

/**
 * The File tab's find bar (file.search, docs/notes/file-find-in-file.md): a band under the
 * tab's two header rows, the same in view and edit mode. What is in it is FindBarView's;
 * Escape closes, clears and puts the keyboard back on the code with the current match
 * selected (in the editor, its selection).
 */
export function FileFindBar({ findKey }: { findKey: string }) {
  const query = useFileFindQuery(findKey) ?? "";
  const focusSeq = useFileFindFocusSeq(findKey);
  const { index, total, capped } = useFileFindCount(findKey);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Only for a new request: a bar that comes back with its tab leaves the keyboard where it is.
    if (useFileFindStore.getState().byTab[findKey]?.focusedSeq === focusSeq) return;
    fileFindFocused(findKey, focusSeq);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [findKey, focusSeq]);
  return (
    <FindBarView
      docked
      className="w-full"
      label="Find in file"
      testId="file-find"
      query={query}
      count={fileCountLabel(query, index, total, capped)}
      canStep={total > 0}
      commands={COMMANDS}
      inputRef={inputRef}
      onQuery={(q) => {
        setFileFindQuery(findKey, q);
      }}
      onStep={(dir) => {
        stepFileFind(findKey, dir);
      }}
      onClose={() => {
        finishFileFind(findKey);
      }}
    />
  );
}
