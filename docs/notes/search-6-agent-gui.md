# Search 6: Agent search in the dialog, restore and Recent searches

PR 6 of 6 in the thread search series, on branch `cf/search-6-agent-gui`. The GUI over the
daemon's SearchService (search-5-agent-daemon) inside the Find dialog (search-4-find-dialog),
plus one small daemon change (a Find entry's result count). Needs a daemon restart: migration
0056 and `search.find --hits` (without the restart the dialog works, and Recent searches shows
Find entries without "N hits").

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/search.proto`, `internal/store/search`, `internal/api/search.go`, `internal/command/commands_search.go`, migration `0056_search_find_hits.sql` | `RecordFindSearchRequest.hits`, `SearchEntry.find_hits`, `search.find --hits N`; `search recent` prints `(14 hits)` |
| `gui/frontend/src/api/search.ts` | view models (entry, hit, step, Watch events), `startAgentSearch`, `watchSearch`, `watchRecentSearches` |
| `gui/frontend/src/lib/agentSearch.ts` | pure: `reduceSearch` (Watch folding), `RESTORE_MS`, `sessionToRestore`, `unseenToRestore`, `restoreSelection`, `moveHit`, `answerPieces`, summary, Recent row and footer texts |
| `gui/frontend/src/stores/searchDialog.ts` | the last mode (persisted, `code-foundry.searchDialog`) and the last open's session (memory) |
| `gui/frontend/src/stores/agentSearch.ts` | the actions: start, `search.stop`, `search.forget`, `search.clear`, `search.seen`, `search.find`, Enter's `openAgentHit` + `revealHit`, ⌘⏎'s `promoteAgent` |
| `gui/frontend/src/components/search/` | `SearchDialog` (modes, Tab, restore, Recent, dictation), `AgentSearch` (the mode), `AgentParts` (steps, answer, summary, hit row), `RecentSearches`, `useAgentSearch` (Watch, WatchRecent), `types.ts`; `FindSearch` gains Recent, "Try Agent search" and the Find record |
| `gui/frontend/src/components/thread/cite/` | `quoteItemSelector` (a user bubble or a question's lines are revealed too), a held Go to source (`requestFlash(…, { hold: true })`) |
| `gui/frontend/mock/agentSearch.ts` | SearchService and `search.*` over the mock world: a scripted run, the history, stop, forget, clear, promote; `/__mock/search` controls |

## Decisions

* **Modes.** `modes.ts` lists Find then Agent search (the header's `Segmented`, "Find |
  Agent search"); the dialog opens in the last mode used, Agent search before any. Tab (and
  shift+Tab) in the field switches and keeps the query; the switch's buttons keep the focus
  in the field. The header icon is a sparkle in Agent mode, the placeholder "Ask about your
  threads…".
* **Agent mode is Enter only.** Typing never starts a run. Enter is the field's: on a
  focused button (×, Clear, an [n] marker, the summary) it presses that button (nothing is
  prevented before the guards). Enter with a question that is not
  the shown search's starts one (StartAgent); with the shown question it opens the selected
  hit; an ended search with nothing selected runs again ("search again"). ⌘⌫ clears for a
  new search; an empty field always shows Recent searches.
* **Starting is the RPC, not `search.agent`.** That command waits for the run's end (the CLI
  streams); the dialog needs the entry at once to watch it. Every other action is its
  command: `search.stop`, `search.forget`, `search.clear` (its confirm, shown over the
  dialog), `search.promote`, and quietly (no toast, an old daemon's refusal ignored)
  `search.open-hit`, `search.seen`, `search.find`.
* **Watch.** One stream while the dialog shows a search, none after it closes (the run goes
  on). `reduceSearch`: a snapshot replaces unless older than the shown version; a change
  applies only past the shown version (step upsert by index, hit by n, answer, status). The
  stream reconnects only while the search runs: the end rule reads the entry folded in the
  stream's own closure, not React state (a ref written in a state updater was still RUNNING
  when the stream ended, and it reconnected). Every attempt folds from scratch: a restarted
  daemon numbers versions from 1 again and marks the run it lost FAILED, so its snapshot (v2
  FAILED) must replace the old v5 RUNNING, or the dialog stays "running" and reconnects about
  4 times a second (the backoff resets on every message). NOT_FOUND shows "This search was
  forgotten."
* **While running**: "Searching" steps (✓ done, spinner while not done, ✗ failed; every
  not-done step spins, as parallel searches run together), the query in code and a read's
  thread name stressed when the step's text has them; "Found so far" hits as they arrive,
  the first selected; the preview's foot has the elapsed time and Stop. The footer says
  "esc close · keeps running". No keyword section.
* **Done**: the answer as plain text (`answerPieces`: `[n]`, `[1][2]`, `[1, 2]` become small
  numbered buttons that select that hit; nothing else is parsed, so markdown and links in
  the model's text show as typed; a marker sits against punctuation after it, "spot 1."),
  the summary line "2 searches · read 3 threads · 21s"
  (hidden when there are no steps) that opens the steps, then the hits: number, thread
  name, project (`useThreadPlace`), archived, day; the quote under a warning rule; why.
  Opened hits say "✓ opened" and are dimmed. FAILED: "Agent search failed: <error>.";
  STOPPED: "Stopped. N results found before it stopped." / "Stopped before it found
  anything."; DONE with no hit: "No messages answer it."
* **Preview** reuses `SearchPreview` with a `paint` (the quote, `paintQuote`: `findText` of
  the message, `locateQuote` with no offsets or context, painted `cf-search-quote` in the
  `cf-cite-mark` look) and no caption. Claude's hits show the prompt before them dimmed, as
  Find's do.
* **Enter on a hit** marks it opened, closes the dialog, selects the thread, then waits (up
  to 10 s) for the thread's log to have the item, expands a question's row, and asks the
  cite layer's Go to source with `hold`: the layer scrolls to the quote, opens what folds it
  away and marks it until the next click or key (a plain Go to source still flashes 1.6 s).
  `revealQuote` finds the item by `quoteItemSelector` (`data-cite-item`, else
  `data-find-item`), so user messages and questions reveal too.
* **⌘⏎** promotes and shows the thread once the thread list has it; a search promoted
  already (its thread listed) shows that thread with no call; the hint then reads "open its
  thread".
* **Restore.** The dialog saves its session when it unmounts (mode, query, shown search,
  selected hit, the hit Enter opened, the results' scroll). Opened within `RESTORE_MS` (3
  minutes, fixed) it shows that again with the query selected; the selection is the next
  unopened hit after the one opened (wrapping, `restoreSelection`). Later it opens empty on
  Recent searches, in the last mode. **Unseen**: when the first Recent list arrives and the
  field is still empty, the newest finished agent search with `unseen` is shown whatever
  the timer; any finished search shown unseen gets `search.seen`. A restored dialog keeps what
  it restored and cues the rest instead: while its field has text, a row at the top of the
  left column (both modes) says "Finished: <query> · 3 results" for the newest unseen
  finished search other than the shown one, "+N more" when there are several; a click shows
  it (and so marks it seen), and the next one takes the row. A restored dialog holds
  WatchRecent throughout for it.
* **A start in flight survives a close.** `stores/searchDialog` keeps the pending StartAgent
  by its question (`trackSearchStart`). When it answers after the dialog closed, the saved
  session with that question and no search takes the entry's id, so a reopen shows it (and
  Enter opens a hit, not a second run). Reopened before it answered, the dialog shows
  "Starting…" and waits for that start (`pendingSearchStart`).
* **Recent searches** (both modes' empty state): WatchRecent while the field is empty (an
  "inline" slot), virtualized 32px rows: sparkle + query + "3 results · 1h" (or "failed",
  "stopped", "running") for agent entries, search icon + "14 hits · yesterday" for Find
  entries; ↑/↓ and Enter while the field is empty; × (on hover or selected) forgets; Clear
  confirms. The preview shows an agent entry's saved results ("Saved results · not re-run")
  or "⏎ runs Find for “…” again". Enter on an agent row shows it (Agent mode); on a Find row
  Find runs it again.
* **Find additions**: opening a result records the query with `threads + totalHits` as its
  count; no results shows a "Try Agent search: “…”" row (click or Enter) that switches mode
  with the query and starts the run.
* **Dictation** reuses `useComposerDictation` (draft key `search-dialog`, not primary) and
  `DictationMic`; the pill sits left of the mode switch, the idle mic shows in Agent mode.
  The palette looks up no chords while open, so the dialog handles the `dictation.toggle`
  chord itself in its key capture; phrases land at the field's caret (`phraseAtCaret`).
* **Tab hints** (Agent's "Tab Find", Find's "Tab Agent search") show only with more than one
  mode (`SearchDialogApi.modeCount`).
* **Footer** right side: "Utility model · <label> · low": the shown search's model, else the
  `models.utility` setting, named by `canonicalModelName`.

### Deviation: a Find entry's count is the daemon's

The daemon kept only a Find entry's query, so "N hits" had nowhere to come from. Rather
than keep counts in the GUI, `RecordFind` takes `hits` and the entry carries `find_hits`
(migration 0056, `ALTER TABLE … ADD COLUMN find_hits INTEGER NOT NULL DEFAULT 0`). Entries
from before show their age alone.

## Gotchas

* The existing Find tests and the Find e2e spec now start with the mode set to Find (Tab in
  the e2e spec), since the dialog opens in Agent search.
* A mock stream generator subscribes only on its first `next()`: the mock's Watch and
  WatchRecent call `next()` before yielding the snapshot, so no event falls between.
* Ref reads in render are lint errors (react/refs): "another search shown" uses the
  state-during-render pattern.

## Left for later

* The model sometimes answers with a markdown list despite "1 to 3 sentences" (seen once:
  `- **"Poll checks by fingerprint":** …`), which reads with its markers as plain text. A
  daemon prompt tweak, or stripping `**` in the GUI, is a separate decision.
* Dictation in the browser against a real daemon is not possible (the host captures the
  microphone), so the dictating screenshots are on the mock.

## Review fixes

An independent review found: the Watch fold surviving reconnects (a daemon restart left a
running search "running" and reconnecting); a close during StartAgent losing the search
(and Enter on the reopen running it twice); unseen results hidden behind a restored
session (now the cue); Enter swallowed on focused buttons; and nits (Recent's preview showed
"0 searches · read 0 threads" for a run that failed early, the mock's seeded search had no
read step, a gap between a marker and its punctuation, `quoteItemSelector` now built from
`findItemSelector`). Each has a vitest test (`useAgentSearch.test.tsx` restart, `AgentSearch.test.tsx`
"Enter on a focused button", the two close-during-start tests and the cue test,
`AgentParts.test.tsx`, `lib/agentSearch.test.ts` cue and `resultsWord`, the mock's seed test).

## Tests

* vitest: `lib/agentSearch.test.ts` (the documented event order, old versions, duplicate
  hit, resync snapshots; the timer's edges; unseen pick; restore selection table; move;
  answer pieces; texts), `components/search/useAgentSearch.test.tsx` (seed then snapshot,
  no reconnect after the status, reconnect + resync after a drop, NOT_FOUND, no id no
  stream), `components/search/AgentSearch.test.tsx` (default mode, Tab, persisted mode,
  switch buttons; typing does not search, Enter starts, steps/hits/preview/elapsed/Stop; Esc
  closes without `search.stop`; done layout, plain answer, markers, summary, opened; FAILED,
  STOPPED; seen; forgotten; Enter on a hit with the log arriving later; ⌘⏎ and promoted
  already; edited question, ⌘⌫; restore within and after the timer with the next unopened
  hit; unseen restore; Recent rows, preview, ×, Clear's confirm; picking rows; Try Agent
  search by click and Enter; the Find record with its count), `stores/agentSearch.test.ts`
  (reveal waits for the log, question expanded, timeout; promote result; mode merge guard),
  `mock/agentSearch.test.ts` (the mock's Watch order, NOT_FOUND, Find replace). Go:
  `TestSearchFindHits`, the store's persistence test keeps `FindHits`.
* WebKit e2e `e2e/agent-search.spec.ts`: `SHOTS=<dir>` makes the PR's Done and cue shots
  on the mock (skipped otherwise); the chord and Tab between modes with the focus
  kept; ⌘⇧M dictating into the dialog's field (one pill, in the header); Enter on a hit
  landing in s-r1 with `cf-cite-mark` on the quote, on screen, then gone after a key.

## Verification

* `make check` green.
* Mock (`make drive`): every state above, by hand and by the e2e spec.
* Real daemon (`make drive DAEMON=dev`, scratch home, `models.utility =
  claude-sonnet-5-5[1m]`, threads on Sonnet 5.5 medium, three threads without a project):
  "where did we decide the PR poller shouldn't refetch on CI reruns, and why?" took 8 s,
  two verified hits (the user's message and Claude's reply) and an answer citing [1][2];
  Enter on hit 2 opened the thread (its log not loaded before) with the quote marked;
  reopening restored it with hit 2 "✓ opened" and the query selected; ⌘⏎ made "PR poller
  CI rerun refetch decision", which answered from the search's context; a Find for
  "fingerprint" recorded "7 hits"; after the timer Recent showed both; a search left running
  behind Esc finished unseen and was restored and marked seen on the next open; Stop ended
  one STOPPED; × and Clear (confirmed) emptied the history. The scratch threads'
  transcripts (and the memory files one of them wrote) were deleted and the scratch home
  removed.
