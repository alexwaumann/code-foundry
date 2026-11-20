# Result list selection worked out during render

Four result lists kept the selected row's key in state and repaired it in a `useEffect` when
the rows or the answer changed, with a ref holding what the effect saw last: FindSearch,
TextFinder, `useFirstRowSelection` (FileFinder and PromptsPicker, both cmdk) and AgentSearch.
An effect runs after the paint, so a new answer's rows could show with the old key selected
(or none) for a frame, and so could the preview beside them.

## What replaced it

- `lib/useListSelection.ts` `useSettled(initial, settle)`: stores state, and during render
  runs a rule that takes what is stored to what this render shows. When the result differs it
  is stored at once (React's "adjust state while rendering"; React renders again before
  committing), so the first commit already has it. The rule must be stable: settling a
  settled value returns the same object, or React loops.
- `useListSelection(answer, keep, initial)` on top: the key is stored with the answer it was
  kept for; `keep(key, sameAnswer)` is the list's existing rule (`keepSelection`,
  `keepMatch`, first-row). FindSearch and TextFinder use it with the answered query or search
  key; `useFirstRowSelection` with the first row's key, as before.
- AgentSearch: `settleSelection` in `lib/agentSearch.ts` is the old effect plus the old
  render-time adjust for another search, as one pure function over `{ entryId, restored, n,
  picked }`. The restore is the starting state (`startSelection`) and is applied once rows
  arrive, compared by identity as the ref did. Its `report({ selectedN })` effect is unchanged.
- Arrow keys compute from the derived key, not from an updater's stored value.

## Why the pick is written back, not only derived

A pure derivation (`pick valid for this answer ? pick : default`) changes three behaviours,
which is why the settled key is written back:

- An answer that comes back (query A, then B, then A again) would bring back the row picked
  for A; before, each new answer started at its first row.
- A picked row that left the list and came back (the same answer) would be selected again;
  before, it gave way to the first row for good.
- AgentSearch's unpicked selection keeps the first hit that arrived as more arrive; a pure
  "first row" would follow a hit inserted above it.

Writing the settled key back keeps all three. The only difference left: a key that is not a
row is now repaired on the render it is set in, not on the next rows change. No caller sets
one (the lists select only their own selectable rows, and an answer's [n] marker is a button
only for a hit that exists).

## cmdk 1.1.1 (read in node_modules/cmdk/dist/index.mjs)

- A controlled `value` reaches cmdk's store in a `useLayoutEffect` and re-renders the items
  through `useSyncExternalStore`, so a value derived in render shows on the same paint.
- `CommandInput` with a controlled `value` sets cmdk's search in a passive `useEffect`; that
  schedules "select the first item in the DOM", which with a controlled root calls
  `onValueChange` with it: the old list's first row, since the answer has not arrived. Our
  rule then drops it when the first row changes, as before.
- An item mounting selects the first item only when the value is empty; the selected item
  unmounting selects the first item left in the DOM and reports it through `onValueChange`.
  That is the new list's first row, which is what the rule selects anyway. Nothing else
  looks again when rows are replaced. So the comment in `useFirstRowSelection` holds, with
  the unmount case added.

## Tests

- `useListSelection.test.tsx` and `useFirstRowSelection.test.tsx` record the selection in a
  `useLayoutEffect` (what cmdk reads, before the paint). The old effect version failed the
  "no commit shows the old row" test and passed the rest, which pin the kept behaviour.
- `settleSelection` and `keepMatch` are table tests.
- e2e: agent-search, file-finder, file-find, file-text-search, file-search-includes,
  prompt-history-picker, thread-search and search-row specs pass unchanged. No new e2e: the
  stale frame is a commit-order fact a layout effect in jsdom shows.
