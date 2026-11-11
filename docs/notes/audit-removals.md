# Removals: placeholders, old-daemon paths, unused mock controls, sketches

Six removals the owner approved, one commit each, plus a testing note.

## What went, and why it was safe

1. **Placeholders for unbuilt features.** The inline page card's disabled Bookmark ("Artifacts
   come in a later release") and the Lineage label's ⋯ menu, whose only item was a disabled
   "Archive finished". Neither did anything; artifacts are parked and no bulk-archive command
   exists. The Lineage label row stays. Their vitest and e2e checks went with them, and the
   run card's "no lineage menu" assertion (it could no longer fail).
2. **The "daemon without ThreadService" path.** Every installed daemon serves ThreadService
   and ListSkills. Gone: the threads store's `availability` (and with it "unavailable"),
   `isMissingService`, the 10 s List retry, the list wipe on NotFound, both sidebar notices,
   the skills entry's `outdated` flag, and the mock's `threads-service` and `missing-rpc`
   controls. A failed List now keeps the threads it has and sets the store's `error`, which
   the empty sidebar shows as "Cannot list threads: … Retrying…" like a stream error.
   `availability !== "unknown"` meant "a List or a thread event arrived"; a thread-list
   snapshot event now sets `loaded` (the stream sends one on every connect), so
   ThreadPane and archiveCleanup read `loaded`.
3. **Unused mock controls.** Every `/__mock` route was grepped (exact and prefix-dispatched
   ones, `mockPost` and `fetch` forms) over e2e, src, scripts, gui/frontend/scripts,
   .claude and docs/sketches. 58 routes had no caller and went, with the World and helper
   code only they reached: call logs nothing read (files, themes, backdrops, clone, create),
   failure switches nothing set (gitops `failNext`, registry errors, `failRespond`,
   `refuseRetry`, `cancelTooLate`), Ember's board setters, the agent-end and Ember restart
   scripts. Also the thread states `parallel`, `shells` and `stopped`, the `start-only`
   setup script, the thread-info scenarios `busy`, `child`, `nogit`, `unnamed` and `servers`,
   and the files `docs/huge.png`, `docs/huge.pdf`, `bin/tool`, `big.log`. `server.ts`'s
   header is now exactly the remaining routes (a script compared the two), and the drive-app
   skill names the handiest ones.
4. **The mock's port of internal/fuzzy.** SearchFiles in the mock ranks plainly: each word a
   substring of the base name, then of the path, then a subsequence; the shorter path first.
   The match set is the same as before for one-word queries (all three e2e specs that search
   files pass); project-name words no longer match (no spec used them). composer-files.spec
   no longer asserts the order; it finds `thread.go`'s row by its label. `mock/prTask.test.ts`
   (LinkOwner, owned by Go's `TestLinkOwner`) and pluginTable.test's sort value case
   (`TestTableSortActs`) went.
5. **docs/sketches.** Kept what something outside cites, by path or bare name: the design
   docs, the plugin docs `DECISIONS.md` defers to (it says the others still stand), the
   agents panel's `l1-strip` shots and session-usage's `session.png` (notes cite them), the
   rendered thread's `style.css` and `variants.css` (thread.css says it was ported from
   them), and alert-sound's README, `wood.py`, `taps.py` and `soft.wav`
   (`gui/notify_test.go` reads it). The mock-ups, shoot scripts, other screenshots, the first
   round's `gen.py` and the listening page went; kept docs no longer point at them.
6. **docs/notes/testing-gotchas.md.** The reusable gotchas from the twelve deleted
   e2e-to-vitest step notes, each checked against a current test that works around it.
   Dropped: ones no current test shows (overlapping `act` scopes), and tool quirks outside
   these libraries (`bun check -b` strictness, oxlint).

## Gotchas

- The findings' candidate lists were wrong in places: the thread states `permission`,
  `question`, `multi` and `subagent` are loaded by thread-prompts.spec through a typed
  helper, and `servers` is reached through the `child-server` scenario. Only a grep of the
  callers (including `${state}` helpers) decides.
- The status-row notice was the app's only reader of `--cf-sidebar-border`, so
  `src/themes/liveSlots.test.ts` failed until docs/THEMES.md moved that slot to "Pages only".
- `holdThread` keeps its `on` argument though only `hold` remains; Ember's timers can no
  longer be added in the mock, so its board's timer list is always empty.
- dictation's state values and other per-parameter knobs of controls that are still called
  were left alone: only whole routes, states, scripts, scenarios and fixtures were in scope.
