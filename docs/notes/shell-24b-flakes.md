# Flaky tests on the shell branch (shell 24b, 2026-11-13)

The tests that failed under load or at random during the shell build, before `shell` merges to
`main`, where every push gets a full sweep and a red one stops releases. Each fix makes the test
wait for, or control, what it raced, or fixes the app where the race was the app's. No timeout was
raised, no sleep, retry or skip added, and no assertion loosened.

How they were run. Go: the `-race` test binary, 24 processes at once on 12 cores, a few rounds
(a small runner with a fixed process count that stops when the load average passes 40). vitest: parallel copies of `vitest run` on the files, and a probe with a tight
`--testTimeout` that shows whether a timeout spreads to the tests after it. e2e: `--repeat-each`
with 4 workers on ports of their own (`E2E_MOCK_PORT`, `E2E_VITE_PORT`, `E2E_DIST`), quiet and
under 10 to 12 busy loops that end themselves. "Before" is `origin/shell` at 97c705258.

## Fixed

| Test | Before | Cause | Fix | After |
|---|---|---|---|---|
| thread `TestRestartBusyInterrupts` | 25/360 | The restarted (resumed) fake replays the same capture for the held message and asks the withdrawn permission again under the same request id, which reopens its item. The test passed only when it read before that replay. | The fake gains `CF_FAKE_CLAUDE_RESUME_FIXTURE`: the resumed process answers with a plain turn. The test also checks the request stays withdrawn after that turn. | 0/360 |
| thread `TestWakeBatchLimit`, `TestWakeBatchMessage`, `TestWakeBatchWindow`, `TestWakeBatchHoldBounded` | 6/360, 1/360, 0/360 (seen in CI) | A real 100 to 300 ms batch window raced the test settling three children; a slow settle missed the batch. | The window reads `Options.batchClock` (the monotonic clock by default); the tests move a manual clock between steps and wait for the queue to drain instead of sleeping. HoldBounded now checks the exact split (7 then 1). | 0/360 |
| thread `TestRestartWakesDelivered` | 2/360 | It waited for the parent "busy", which a wake's message sets before Claude's handshake; a stop then is not a running turn cut, so no notice. The children's wait had the same hole. | Wait for connected and busy (the loner already did). | 0/360 |
| thread `TestRestartWakesSkipArchived`, `TestArchiveWakes` (batch case) | not seen | Same window race as the batch tests: the archive had to land inside 300 ms. | The manual clock; the window ends after the archive. | 0/360 |
| thread `TestWaitingUntilWake/stopped_subscriber` | 1/576 | It read the snapshot (finished), then only the events already on the bus; the last status event could still be on its way. | Read events until the finished one, with a deadline. | 0/360 |
| thread `TestSendAfterACancelStartsOver` | 0/936 | Not reproduced. By reading: `Setup.Queued` clears as the store writes the pipe, but `sentTexts` reads the fake's stdin log, written after the fake reads the pipe. | `sentTextsN(n)` waits until the fake logged n messages, then compares exactly; used at the six such sites. | 0/360 |
| thread `TestStoppedDaemonGivesTheStepTheRestart/a_fetch` | 7/480 | Naming runs beside the fetch; when the stop came before naming ended, both steps failed and the test took the first failed one (naming). | Check the step of the case's kind, after the fetch shows running on the row. | 0/480 |
| project `TestFilesEventLiveOnly` | 5/240 | **App.** `onEvents` added a delivery's paths one by one and re-triggered the tree window after each, so a window closing partway (a slow loop, or an earlier trigger's window) split one delivery into two files events, and the 500 cap saw neither whole. | The delivery's hits go into the collector under one lock and trigger once per worktree. | 0/240 |
| hello `TestTick` | 0/1,920 | Not reproduced. By reading: it read the delivered counts, then the fires; a tick between the two reads made the fires longer (index out of range). The host appends both under one lock. | Read the fires first. | (not reproduced) |
| plugin `TestValidateViewDeepIsCheap` | seen once | A 5 s wall-clock limit under `-race` measured the machine. | Count allocations: at most 4 per node (decoding takes about 2.3; a per-level path walk would take one per node per level). The 64 MB bound stays. | deterministic |
| vitest `PullRequestSurface`, `PrTasks` cascade | injected: 2 failures; probe: 56/56 | Vitest fails a test at its timeout but its body keeps running. The files' fakes are module level (`world` is reassigned per test), so the late body's holds and failures landed in the next test's world, and its open `act` scopes swallowed the next test's renders ("Unable to find"). One slow test under load failed 30 to 50 after it. | `src/test/isolate.ts`: an `it` that records each body; `trackTests()` makes the next test wait for it, and the file's afterEach waits too, before cleanup; `settle` and `openPr` stop a timed-out body at their next step (`context.signal`). The slowest test (draft, read-only, merged, decline, refusal) is four tests. | injected: 1 (the timeout itself); probe: timeouts only |
| vitest `tablenode`, `PullRequestsPage` | 3/12 copies at load 25 to 28; probe: 9 and 13 cascade errors | The same cascade. | `trackTests()`. | 0/12; probe: timeouts only |
| vitest `plugin/fuzz` | seen in full runs | One test rendered 150 mutated views, 3.4 s alone; run-list (a 79 KB view) is 1.4 s of it. | One test per demo tab over the same seeds, and a cheap check that more than 100 of the 150 still parse. | longest 1.5 s |
| vitest `guards.test.ts` | seen in full runs (5 s) | The three whole-tree guards parsed every source file four times between them (355 to 557 ms each alone). | The scanner keeps each file's parse: 133 to 177 ms each. | |
| vitest `ansi.test.ts` | 347 ms against 250 | A wall-clock limit. | Count `charCodeAt` reads: at most two per character (83,780 reads for 77,780 characters; re-reading earlier lines would be millions). | deterministic |
| e2e `shell-spaces.spec.ts` (the new space's name field) | 8/40 quiet | **App.** "+" shows the new space, whose composer focuses its prompt a frame after it mounts, and opens the space's name field, which focuses at once and ends the rename on blur. When the composer's frame came second, the field closed before anything could be typed. | On mount the prompt leaves the keyboard in a text field that took it within that frame (`Composer.tsx`; vitest `ComposerMountFocus.test.tsx`). | 48/48 quiet, 6/6 under load |

## Not reproduced, left as they are

| Test | Tried |
|---|---|
| plugin `TestMisbehavingPlugins/flood` | 96 runs (16 processes) and 12 whole-package copies at once: all passed. Its one-second answer limit during the flood is a wall-clock check; with no failure text to go on it is left. |
| e2e `thread-info.spec.ts` narrow overlay, `linkedprs.spec.ts:35` | 8 each under load (load 32), two full suites (quiet and under 12 busy loops, 545 passed each), and 6 more under load: all passed. Possibly fixed by the shell review fixes (#706, #707) since. |
| e2e `skills.spec.ts` (Escape closing Settings with the dialog) | 48 under load, plus the full and targeted runs. The dialog opens from a menu item's select (a discrete update, its layer registered before it paints); no window found by reading. |
| e2e `app.spec.ts` "worktree.create from the palette" | 4 cold runs (the e2e build removed first), the full runs and 6 under load. |
| e2e `gallery.spec.ts` thumbnail, `citations.spec.ts:39`, `thread-find.spec.ts:124`, `zoom-popovers.spec.ts` at 90% | The full runs and 6 each under load. |
| vitest `palette`, `xterm`, `ComposerSets`, `FileTab` timeouts | 12 copies of `vitest run` at once (load 72, 144 jsdom workers on 12 cores) time out everything heavy, these among them; at 4 copies (load 25 to 28) they all pass, before and after. Their slowest tests do real work (xterm writing past its 50 MB limit, a whole-tree literal scan); none cascades now that it would matter in the files that do. |

## Decisions and gotchas

- `Options.batchClock` is unexported: only the package's tests set it. The real clock is the
  monotonic one the window always used (`time.Now`, `time.NewTimer`); `Options.Now` stays the wall
  clock for slots and timestamps.
- `CF_FAKE_CLAUDE_RESUME_FIXTURE` is the general answer to "a resumed fake replays the capture's
  first turn": real Claude never re-asks a request id.
- `src/test/isolate.ts` is per file: vitest 5 does not export `setFn`, so a setup-file hook cannot
  wrap every test without its internals. Hooks run in registration order, so `trackTests()` goes
  before the file's own `beforeEach`. Files whose fakes live at module level and that have seen a
  cascade use it; others can adopt it the same way.
- The tight `--testTimeout` probe (100 to 150 ms) is a quick way to see a cascade: after the fix,
  every failure in the file is a timeout of that test, none an error from a neighbour's state.
- The render-error noise ("thread tab failed to render ... reading 'map'", WaitingStrip) in
  `PullRequestSurface.test.tsx` predates this change (7 lines in a verbose run before and after).
