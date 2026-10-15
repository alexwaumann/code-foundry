# Flaky tests on main CI (2026-10-11)

Six `ci` failures on main over 2026-10-10/11, all flakes in three places. Each was handed to
an Opus 5.5 high agent to reproduce and fix.

## `TestTimeoutAndClose` (internal/store/gitops) — 2 failures

Not the 50ms op timeout; the fake runner blocks `fetch` on purpose so that half is
deterministic. The flaky half gave `Fetch` a 20ms caller deadline and then expected the op
to be in the snapshot as running. That 20ms had to cover `resolveRemote` (a real
`git symbolic-ref` probe) plus the lane goroutine publishing `Started`. Slow macOS `-race`
runners missed it.

Fix: split into `TestTimeout` and `TestCallerLeavesThenClose`. The latter subscribes to
the bus, waits for `Started`, then cancels the caller. No deadline left to race.
Store unchanged: an op appears in the snapshot only when `Started` is published, which is
the documented event/snapshot rule.

## `TestStatusAfterDaemonCrash/busy` (internal/store/session) — 1 failure

Real store bug. `commitLocked` swapped in the new snapshot before `saveSession` wrote the
row. `Snapshot()` is read without `m.mu`, so a reader (the GUI, or the test's `waitFor`)
could see `busy` while the DB still said `unknown`, and a crash in that window lost a
status already shown. Every other write path saved first; this was the only one out of order.

Fix: persist, then rebuild the snapshot, then publish. Reproduced locally several times
per 50 runs before the fix; 300 runs clean after.

## Vitest `ReferenceError: window is not defined` (gui/frontend) — 3 failures

`@wailsio/runtime` `drag.js` starts a 50ms `setInterval` at import; the first tick ran
after jsdom teardown. Already fixed on main by the pnpm patch in `4cc4efa` (all three
failures predate it). Added `src/test/setup.ts` anyway: it mocks `@wailsio/runtime` so no
unit test loads the real runtime (34 of 80 files did, mostly via `src/api/endpoint.ts` and
the generated bindings). Removing the mock makes those 34 fail, so the mock covers the
whole graph.

## `panel.spec.ts` drag-resize on WebKit (seen once, 2026-10-11)

The rendered threads PR 2 builder saw a drag-resize test fail once on WebKit. Not caused by
that branch (it touches no panel code) and not reproduced: the full suite, and the six
drag tests 15 times each, passed on WebKit. Likely load: the drags are real mouse moves in
4 steps and the assertions poll the panel's width. If it shows up again, run with
`E2E_MOCK_PORT`/`E2E_VITE_PORT` set so another worktree's e2e is not sharing the ports.

## `sidebar.spec.ts:210` Projects page on WebKit (seen once, 2026-10-12)

In a full `make gui-e2e` on the cold-cache branch: the click on a workspace member's
remove button timed out because the toasts of the previous steps ("added dotfiles to
workspace login", "removed code-foundry from workspace login") sat over it and Sonner's
section intercepted the pointer for the whole 20 s. Passed 5/5 alone and on Chromium in
the same run. Not investigated further; a fix would wait for or dismiss the toasts before
clicking.

## `TestConnRequestCorrelation` (internal/claudestream) — 1 failure, fixed

Seen in `make check` on the rendered threads PR 4 branch (2026-10-12): "set mode err =
<nil>". The test answers two control requests out of order and read both callers' results
from one channel, assuming the set_permission_mode caller would send first; under load the
initialize caller woke first. Each request now has its own channel (50 `-race` repeats
green). Not a Conn bug: the Conn hands each answer to its own request's waiter; only which
waiter's goroutine runs first was left to the scheduler (review: confirmed, 50 more `-race`
repeats green).

## `terminal-routing.spec.ts` "cmd+t on a thread …" on WebKit — app bug, fixed

Seen in the PR 4 full e2e run and once in 5 repeats (2026-10-12): the focus ended in the
content terminal, not the new bottom shell. PR 4 first made the test wait for the thread's
terminal to be live before cmd+t; the review found that hid a real race and reverted the
wait. A focus log (focusin stacks) showed xterm's own `_keyUp` refocusing the thread's
terminal after the shell had the keyboard: xterm focuses its textarea on every keyup
except shift/ctrl/alt's (cmd is not on its list), and under load WebKit delivered the
keyup of `t` / of cmd after the shell focused. A person who holds cmd+t a little longer
than the shell takes to open can hit the same. `terminal/xterm.ts` now answers a keyup of
an app chord, or of cmd, with false so xterm skips the refocus. Without the wait: 1 failure
in 6 to 1 in 30 repeats before, 100 + 40 WebKit and 40 Chromium repeats green after.

## `TestPollCacheRestart` (internal/store/gh) and `TestRenderedSetEffortGap` (internal/store/session) on CI — timing, open

Seen 2026-10-13 on the MCP panel PR's first CI run (#71, `go test -race` on the macOS
runner): the poller test's restart snapshot differed from the expected one, and the
effort-gap test saw its held message delivered 0 times to either process after the
restart was "applied". `TestPollCacheRestart` also failed once on main's previous commit
(58e2d9e) next to a green run of the same sha. Neither test touches code that PR changed.
Locally both pass 5 `-race` repeats, and the effort-gap test passed 20 `-race -cpu 2`
repeats with the MCP status polling in place, so the MCP change is not the cause. The
re-run of the failed job was green. Both look like the slow runner stretching a wait past
a test's deadline; not yet reproduced locally, so no fix. If either recurs, capture the
full log of the failing run before re-running it.

## `TestCLISettings/get_after_set` (cmd/code-foundry) — store bug, fixed (2026-10-15)

Seen 2026-10-13 and on PR #105's run 38692064459 attempt 1: `settings get` printed 13
right after `settings set appearance.font_size 15` printed 15. Not the test: the settings
store's watcher `reload` read `settings.toml` *before* taking `s.mu`. The previous
subtest's `set` (naming model) wrote the file, its debounced reload read it, `Update(15)`
then took the lock, wrote, published 15 and returned, and the reload got the lock next
and published its stale bytes (font size 13) until the following fs event repaired it.
Any client could see a setting flip back for one debounce after setting it.

Fix: `reload` reads under `s.mu`, so an Update's write and a reload's read are ordered.
`TestReloadNeverRevertsAnUpdate` pauses a reload right after its read (a `readFile`
package seam) and runs an Update in the gap: 13 every time before the fix, 20/20 after;
`TestCLISettings` 20 `-race` repeats green.

## `TestClearRescansEveryTranscript` (internal/store/session) — test order, fixed (2026-10-15)

Seen on PR #105's run 38692064459 attempt 2: "timed out waiting for first file" with the
run A1 present, `done`, and no usage. Not the earlier SIGUSR1 cause (agents-1-daemon.md).
The test wrote the thread's transcript, spawn *and* completed result, before
`writeAgent` wrote the run's meta file and then its line. A run met first at its closing
result is drained once by `close` and never again, so a runner that read the transcript
after the meta file appeared but before the run's line was appended closed A1 empty.
Claude never writes in that order (the run's file is complete before the result lands in
the thread's transcript), so the runner is right and the test now writes the run's files
first. Widening the gap with a 300 ms sleep between meta and line failed 3/3 before and
passed 5/5 after. The 60 ms sleep before the /clear transcript also went: a newly
followed transcript is read from its start whenever it was written. Not reproduced
without the widened gap locally (100 runs under 24 `yes` burners); after the fix, this
test and `TestAgentRunsRollUpAndPersist` passed 50x at `-race -cpu 1,4` under the same load.

## Gotchas

- Agent worktrees don't have libghostty-vt built; `make check` there needs
  `PKG_CONFIG_PATH` pointed at the main checkout's `third_party/ghostty-vt`.
- CI attempt counts are all 1, so flakes show up as separate failed runs rather than
  re-run attempts; `gh run list --workflow ci --json conclusion` is the quick way to see
  the failure rate.
