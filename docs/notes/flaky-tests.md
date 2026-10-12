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

## `TestConnRequestCorrelation` (internal/claudestream) — 1 failure, fixed

Seen in `make check` on the rendered threads PR 4 branch (2026-10-12): "set mode err =
<nil>". The test answers two control requests out of order and read both callers' results
from one channel, assuming the set_permission_mode caller would send first; under load the
initialize caller woke first. Each request now has its own channel (50 `-race` repeats
green). Not a Conn bug.

## Gotchas

- Agent worktrees don't have libghostty-vt built; `make check` there needs
  `PKG_CONFIG_PATH` pointed at the main checkout's `third_party/ghostty-vt`.
- CI attempt counts are all 1, so flakes show up as separate failed runs rather than
  re-run attempts; `gh run list --workflow ci --json conclusion` is the quick way to see
  the failure rate.
