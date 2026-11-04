# Search answer pane

The ⌘⇧F Agent search dialog put the whole answer at the top of the left column as plain
text. A long one pushed the hits about 1300px below the fold with nothing to say they were
there, and markdown from the model showed raw. Now the left column starts with a short
Answer row and the right pane shows the whole answer rendered. Needs a daemon restart for the
prompt and the follow-up (no migration); the GUI half works without it.

## What landed

| Path | What |
|---|---|
| `internal/store/search/prompt.go` | the answer may use light markdown; `wrapUpMessage` to match; `reportMessage`, `citesReports`; `promoteMessage` puts the answer on its own lines |
| `internal/store/search/run.go` | the one follow-up: `loop.held`, `wantsReports`, `askForReports` |
| `gui/frontend/src/lib/answerMarkdown.ts` | `answerPieces` (moved), `withoutRefs`, `rehypeInert`, `rehypeAnswerRefs` |
| `gui/frontend/src/lib/markdownPlugins.ts`, `components/pr/Markdown.tsx` | `MarkdownExtras.inert` and `.citation` |
| `gui/frontend/src/lib/agentSearch.ts` | `ANSWER_ROW`, `hasAnswerRow`, `resultRows`, `defaultSelection`, `answerPreview`; `restoreSelection` and `moveHit` work over rows |
| `gui/frontend/src/components/search/` | `AnswerRow`, `AnswerPane`, `AnswerText` rendered; selection in `AgentSearch` |
| `gui/frontend/mock/agentSearch.ts` | `POST /__mock/search?long=1`: a long markdown answer with up to 8 hits |

## Decisions

* **`ANSWER_ROW = 0`.** A hit's n starts at 1, so `selectedN` keeps one number for either kind
  of row and the session, `report` and `restoreSelection` need no new field. A `[0]` in the
  text cannot select the row: a marker only exists for a hit that does.
* **The Answer row exists once the search has ended** (`hasAnswerRow`). The answer event comes
  just before the status event, and while a run goes hits behave as before.
* **A run's end selects the Answer row unless the user picked a row.** "Picked" is a key, the
  pointer, a marker, or a restored selection. Yanking the preview from under someone reading a
  hit would be the surprise; the row is at the top of the column either way.
* **A running search reports no selection** unless picked: its first hit is not a choice, so a
  dialog closed mid-run and reopened after the end lands on the Answer row. `show()` passes
  null for a running entry for the same reason.
* **Restore.** The Answer row wins when it was selected last, even with an opened hit in the
  session. After an opened hit the selection moves over hits only (wrapping does not stop at
  the Answer row); with every hit opened it falls to the first row, the Answer row.
* **Enter on the Answer row moves to the first hit** (the hint says "first result"). It has
  nothing to open, and the old fallback, asking again, would run a paid search from what looks
  like a harmless key. With no hits the hint already says "search again", so that stays. ⌘⏎ is
  unchanged. A click selects the row; it does not open anything.
* **A marker with no such hit stays as typed**, `[7]`: a button would select nothing and blank
  the pane. Without `onRef` (Recent's preview) a marker is a plain number, not a dead button.
* **Inert in the tree, not in the renderer.** `rehypeInert` runs before anything draws: a link
  becomes its children, an image its alt text, a raw node its text, so no `<a>` or `<img>`
  reaches React and the `img` renderer's https loading never runs. The sanitizer stands behind
  it with a schema without `a` and `img`. Stricter than `html: false`, which still builds
  `<mark>` and friends: here every tag shows as typed.
* **Markers skip code.** `rehypeAnswerRefs` walks text nodes but not `code` or `pre`, and runs
  after the sanitizer so its properties survive. `citesReports` strips code for the same
  reason. Neither requires a space before the bracket: models write `word[1]`, so `args[1]` in
  plain prose still reads as a marker when hit 1 exists.
* **The Answer row's text** drops the `[n]` and joins blocks onto one line: the row cannot hold
  buttons, and the clamp needs running text.
* **`endedNote`.** DONE with no hits and an answer says nothing when the answer says so itself,
  and "It reported no messages to open." when it cites something. "No messages answer it." is
  for no answer at all. The note now comes after the Answer row.

## The follow-up

A turn that ends cleanly on an answer citing `[n]` with zero hits gets `reportMessage` once.

* **The answer is held, not dropped.** It was a finished answer, so whatever cuts the follow-up
  short the run ends DONE with it: empty text, an API error, an interrupt, the wall time, a
  stop, claude exiting, a failed send. Only a clean follow-up turn with text replaces it.
* **Never twice:** the `held` branch runs before the check, and returns.
* **Not after a wrap-up.** A run told "report nothing more" is not then asked to report.
* **Limits still apply.** `calls` keeps counting, so the cap can interrupt the follow-up; the
  `held` branch then ends the run rather than sending a wrap-up, which could replace a good
  answer with "nothing answered" since it says to write from the reports made.
* **A stop in the follow-up is DONE, not STOPPED**, with `byUser` so it is not unseen: the
  answer was complete before the stop.
* **False positive seen once:** told not to report, the model's first turn refused and
  mentioned `[1]`. The follow-up fired and it then searched properly, which was the right
  outcome anyway.

## Gotchas

* `agent.jsonl` gained a second turn: runs in other tests end on `[1]` with no hit, so they now
  get the follow-up and would otherwise wait out the wall time.
* `newHarness` takes an absolute fixture path, so the table test composes its turns in code.
* `answerPieces` moved to `lib/answerMarkdown.ts`: `lib/agentSearch` needs `markdownText`, which
  needs `markdownPlugins`, which needs the rehype passes; left in place it was a cycle.

## Left for later (mock only, not this change)

* `search.seen`, and any `search.*` command returning an entry through `out()`, throws in the
  mock: `JSON.stringify` on the entry's BigInts, a console 500. The state change has happened
  by then, and the GUI ignores the refusal.
* `Hub<void>` never delivers: `publish()` queues `undefined`, which `subscribe` reads as empty.
  The mock's WatchRecent therefore sends its first list only. Reopening shows the current list.

## Verification

* vitest: `lib/agentSearch.test.ts`, `components/search/AgentParts.test.tsx`,
  `AgentSearch.test.tsx`, `mock/agentSearch.test.ts`. Go: `TestReportFollowUp`,
  `TestReportFollowUpTakesItsHits`, `TestStopDuringReportSend`, `TestCitesReports`.
* WebKit e2e `e2e/agent-search.spec.ts`: hits in view under a long answer, the two-line clamp,
  the pane scrolling alone, the selected row kept in view, a marker keeping the field's focus.
* Mock (`make drive`): every end state, restore, Recent's preview, a 760x560 window (no
  horizontal overflow, the code block scrolls inside itself). Light theme in the e2e shots.
* Real daemon (`make drive DAEMON=dev`, scratch home, Sonnet 5.5, threads at medium, the search
  at its fixed low): a two-topic question answered with bullets, bold, inline code and `[1]`
  `[2]`, rendered in the dialog with marker buttons. A question telling it not to report drew
  one follow-up; the transcript shows the model then searched, reported and repeated its answer
  with `[1]`, one hit accepted. ⌘⏎ gave a thread whose first message has the answer on its own
  lines. The scratch transcripts and home were deleted.
