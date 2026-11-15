# A faster local `make check`: plugin helper without -race, frontend phase skipped (2026-11-15)

`make check` is what an agent waits on before every pull request, one at a time per
machine. Follows `docs/notes/check-speed.md`.

## What a check cost before this

Measured on main (ba9b179c3), 12 cores, in a new worktree:

| Scenario | go-lint | go-test | frontend-check | Total |
|---|---|---|---|---|
| New worktree, first check | 57 s | 153 s | 106 s | 316 s |
| Re-check, nothing changed | 3 s | 23 s | 113 s | 139 s |
| Re-check after an edit in `internal/command` | | 92 s | about 100 s | |
| Re-check after an edit in `internal/store/thread` | | 118 s | about 100 s | |

Two things stood out. The frontend phase costs about 100 s whatever changed: vitest has
no result cache. And after the `internal/command` edit, 79 of go-test's 92 s was
`internal/store/plugin`.

## Plugin store tests: the helper plugin is built without -race

The plugins those tests run were the test binary re-executing itself, so every plugin
start was a race-instrumented process: about a second each on macOS arm64, the cost
`docs/notes/fake-claude-binary.md` removed from the thread store.

- `plugin.HelperBin(t)` (`helperbin_internal_test.go`) builds the same test binary a
  second time with `go test -c`, which does not inherit `-race`, on first use, and the
  three places that wrote a `bin/plugin` script point at it. `TestMain` removes it.
- The helper modes stay in the test files beside the tests that use them. A separate
  `cmd/` main (the fake claude's shape) would have meant moving every mode into a library
  package for no further gain.
- The Manager and the tests still run under `-race`. What loses it is the plugin's side
  of the pipe, which is `pluginsdk` code with its own race-tested suite.
- Built lazily, not in `TestMain`, so a fuzz worker or a `-run` of tests that start no
  plugin pays nothing. Each split group (`scripts/go-test.sh`) builds its own copy: the
  compile is in the build cache, the link is a second or two.

`go test -race -count=1 ./internal/store/plugin`, idle machine, two runs each:

| | Run 1 | Run 2 |
|---|---|---|
| Before | 194 s | 195 s |
| After | 64 s | 60 s |

What that buys in a check depends on what else runs:

| `make go-test` | Before | After |
|---|---|---|
| Everything re-run (`GOFLAGS=-count=1`, builds warm) | 113 s | 114 s |
| After an edit in `internal/command` | 92 s | 59 s |

A full run is no shorter: it is bounded by the thread store's longest group (109 s) on a
saturated machine, and the plugin groups' own times fell (98, 86, 39, 34 s to 79, 39, 24,
21 s) without moving that bound. The gain is where the plugin store was the longest
thing running, which is any change to a package it imports but the thread store does
not.

## Frontend phase: skipped when the branch touches none of its inputs

- `scripts/check-scope.sh frontend` decides; `make check` runs `frontend-check` only when
  it says so. `CHECK_ALL=1 make check` runs it regardless.
- The inputs are `scripts/frontend-inputs.txt`: `gui/frontend/`, the Makefile and
  `scripts/`, the protos, the page library, and the files outside `gui/frontend/` that
  frontend tests and the mock daemon read (the shared layout fixtures, `internal/command/`
  for the mock's command and chord lists, `bridge.js`, `frame.js`, a few docs).
- A changed path is anything that differs from the merge base with `origin/main`:
  committed, staged, unstaged, untracked, and both names of a rename. No base, or nothing
  changed, runs the phase.
- The list is kept complete by `TestFrontendInputsListed` (`scripts/check_scope_test.go`):
  it reads every file the phase loads for a relative path that leaves `gui/frontend/` and
  exists, and fails if the list lacks it. It found `docs/THEMES.md`, which the first
  draft of the list missed. It is a Go test so that it runs in the phase that is never
  skipped.
- The sweep on main calls `make go-test`, `make go-lint` and `make frontend-check`
  directly, so it still runs everything. A skipped phase that would have failed shows up
  there, not on the pull request.
- The Go phase is not skipped for a frontend-only branch. Go caches its own results, so a
  re-check costs about 26 s; only a new worktree's first check pays the full Go phase.

## Gotchas

- The guard sees relative paths written out in the source (`new URL("../../../internal/…")`,
  a `?raw` import). A path assembled at run time from a repository root would get past
  it; nothing does that today.
- `vite.config.ts` is left out of the guard: its paths are the folders Vite may serve
  from, which are wider than what is read (all of `docs/`).
- `internal/command/` is an input, so a branch that adds or changes a command still runs
  the frontend phase.

## Looked at and not done

- Sharing Go test results between worktrees with `-trimpath`. A second worktree at the
  same commit reused 49 of 74 packages' results (go-lint 44 s to 2 s, go-test 162 s to
  117 s), but not the heavy packages, and 27 tests failed under trimmed paths
  (`stat .: no such file or directory`). About 85 s on a worktree's first check only;
  judged not worth it.
- Cutting the vitest layout fuzz from 300 seeds to 30: no change in wall time locally
  (93 s against 93 to 108 s). The frontend phase is bounded by per-file environment and
  import time, not by that test.
- Running the DOM-free `.test.ts` files under the node environment (146 qualify as they
  are) is the next candidate for the frontend phase.

## The thread store, looked at and not changed

`internal/store/thread` is the longest thing in a full Go run (783 tests, run one after
another). Measured alone, `go test -race -count=1`, idle machine:

- 260 s as one process; 175 s without `-race`. Its 67 tests of a second or more hold 171
  of the 260 s, mostly table tests whose rows each wait out a fixed window (a 300 ms
  "nothing fires" settle, the one-second `cdSettle`, the two-second stream kill grace,
  `StrayGrace`).
- It uses about 333 CPU-seconds, more than the next four packages together (project 94,
  plugin 56, `pluginsdk/ui` 55, `internal/db` 44). A CPU profile of the test process:
  about half is the race detector's runtime, a fifth is the scheduler looking for work
  between the 10 to 20 ms polls, a tenth is sqlite parsing the statement of every
  `saveThread`. No single hot spot.

`t.Parallel()` on every test was tried. All but 17 can take it: 12 set environment
variables (`t.Setenv`) and 5 search tests reassign `maxSearchCandidates` or
`searchBackfillChunk`, which the race detector caught at once.

| | Serial | Parallel |
|---|---|---|
| The package alone | 260 s | 66 to 78 s (six runs, all green) |
| `make go-test` after an edit in the package | 118 s | 96 s |
| `make go-test`, everything re-run | 114 s | 121 s |

Not kept. A full run is no shorter, because all 12 cores are already busy during it and
the package's CPU does not shrink: the per-test times summed to 598 s in parallel
against 258 s serial, and single tests stretched two to five times
(`TestSendRacesTheLanding` 2.0 s to 10.3 s). That stretch is the margin the timing
tests have, which is what the check lock exists to protect, and 22 s on one scenario
does not pay for it. Unsplit, in the `./...` run, the parallel package was slower again
(128 s after an edit).

Worth trying again on a machine with cores to spare, where the parallel run would not
saturate it. On this one, a full run gets shorter only by using less CPU.
