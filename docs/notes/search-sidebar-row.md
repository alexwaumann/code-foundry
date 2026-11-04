# Search sidebar row

An agent search keeps running after the ⌘⇧F dialog closes, and nothing said it had finished
until the dialog was opened again. Now a row in the sidebar's menu pane, after Projects, says
so. It is the only signal: no toast, no Dock alert, no sound. Needs a daemon restart (the
new event source; without it the row never shows and nothing else changes).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/search.proto`, `events.proto` | `SearchActivity`, `EVENT_SOURCE_SEARCH` (18), `Event.search` (19), sent after memory |
| `internal/store/search/activity.go` | `Store.Activity()`, and publishing it on the bus when it changes |
| `internal/api/search_events.go` | EventService's search source |
| `internal/command/commands_view_search.go` | `search.open [<id>]` |
| `gui/frontend/src/stores/searchActivity.ts`, `lib/searchActivity.ts`, `components/search/SearchNav.tsx` | the state, the row's words, the row |
| `stores/threadSearch.ts`, `stores/searchDialog.ts`, `components/search/SearchDialog.tsx` | `presentSearch(id)`, the target, opening on it |
| `keys/bindings.ts` | `startCommandNamed(name, args)`: args reach the command's presenter |
| `mock/agentSearch.ts` | the activity, and a daemon restart failing what runs |

## Decisions

* **A summary on the event stream, not a held stream.** WatchRecent sends the whole history
  (50 entries with their steps and hits) on every change, steps included, so holding it all
  session is wasteful. A narrow stream of its own would be cheap in bytes but takes one of the
  GUI's five stream slots (`api/streamSlots.ts`) for good. So the daemon sends a five-field
  `SearchActivity` on EventService: it adds no connection, and reconnecting, resuming and the
  snapshot after a restart are the event stream's own.
* **Published only when it changes.** The store reads it after an entry change, a run's end
  or a removal, never after a step, hit or answer (a run's hits count only once it has ended),
  and sends it only when it differs. A run costs two events: its start and its end.
* **Always whole.** The GUI replaces what it had. A restarted daemon marks the run it lost
  FAILED and unseen, so its snapshot carries no running id and "Searching…" cannot stay. That
  run then shows as "Search failed": the user left it running and it did not finish.
* **Newest means finished last**, not started last: with two at once the row shows what has
  just happened. The dialog's own unseen pick (`unseenToRestore`, the cue) goes by the
  history's order; the row names its id, so the two never disagree about what a click opens.
* **The words.** Finished with hits: "Search results" and the count in the Pull Requests
  amber pill. No hits: "No search results", no pill. Failed: "Search failed" in the error
  tone, no pill, even when it reported hits first (the dialog shows them under the failure);
  a count there would read as success. A run that hits the time limit ends DONE, so it reads
  as results. No tooltip: the row's words and number are all there is to say.
* **`search.open` takes an optional id** rather than a new command. It stays in the palette
  (the palette prompts only for required args and enums) and keeps its chord. The row runs it
  through its window-local presenter, as ⌘⇧F does, so only that window opens; `code-foundry
  search open <id>` reaches every window through ShowView, as the verb always did.
* **The search is read first.** `presentSearch(id)` calls SearchService.Get, then opens, so
  the dialog has the question and the hits on its first render and shows no flash of Recent
  searches. A search forgotten meanwhile (or a Find entry's id) opens the dialog as ⌘⇧F does.
* **Opening on a target is a restore.** The query is selected, another unseen search shows
  in the dialog's cue rather than replacing what was clicked, and a target that is the search
  the last close showed keeps its selection and scroll. A target overrides any other session.
* **A target reaches an open dialog** through `targetSeq`, the dialog's key in the palette.
  Only the CLI can do that, the row being hidden.
* **Every running search counts**, the ones `code-foundry search agent` started too: the
  daemon cannot tell them apart and they end unseen as well.

## Gotchas

* The target is read in `useState`'s initializer and cleared in an effect, not taken in the
  initializer: StrictMode calls initializers twice.
* A thread removed after a search finished lowers the dialog's hit count at once and the
  pill's only at the next activity read (the store publishes on search changes, not thread
  ones). The dialog is the true count; the pill goes when the search is opened.
* `make drive DAEMON=dev` tears down when its daemon dies, and a browser's `?daemon=` port is
  fixed while a daemon draws a new one, so a live GUI cannot follow a real daemon restart.

## Tests

* Go: `TestActivity` (table), `TestActivityPublishedOnChangeOnly`, `TestActivityClearsWithTheEntry`
  (forget, clear, promote), `TestActivityStoppedRun` (stop, forget while running),
  `TestActivityAfterARestart`, `TestSearchEventSource`, `TestSearchOpenOnASearch`.
* vitest: `lib/searchActivity.test.ts`, `components/search/SearchNav.test.tsx` (states, click,
  hidden with the dialog, replaced by each event), `components/search/SearchTarget.test.tsx`
  (opening on a search, kept place, running, cue, an open dialog),
  `stores/threadSearch.present.test.ts`, the activity in `mock/agentSearch.test.ts`.
* WebKit e2e `e2e/search-row.spec.ts`: the flow across the dialog and the event stream with
  no stream held for the row, a daemon restart mid-run. `SHOTS=<dir>` makes the PR's shots.

## Verification

* Mock (`make drive`): running, results, click and seen, two at once (the newer shown, the
  other left on the row and in the cue), failed, no hits, seen and forget through the
  commands, `search.open` with an id through the daemon, stop (nothing shows), a click on a
  running search, forgotten while running, a restart mid-run.
* Real daemon (`make drive DAEMON=dev`, scratch home, `models.utility =
  claude-sonnet-5-5[1m]`; a search always runs at low effort): `search agent` with the dialog
  closed showed "Searching…", then "No search results" (2 searches, 3 s); a click opened it
  DONE, marked it seen and the row went.
* Real restart, on a scratch daemon with `events --source search --json`: `kill -9` mid-run,
  the old stream's last event `running: 1`, the next daemon's snapshot `unseenId` with
  `SEARCH_STATUS_FAILED` and no running. The GUI's side of it is the mock's e2e.
