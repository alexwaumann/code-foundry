# A faster `make check`: the slow Go packages run in groups (2026-11-11)

`make check` is the only gate for a pull request and runs one at a time per machine
(`docs/notes/ci-rethink.md`), so its length is every agent's queue. A full run with
nothing cached took 439 s; it now takes 186 s.

## Where the time was

Measured on main (41565ba25), one package at a time, `go test -race -count=1`:

| Package | Time | Top-level tests |
|---|---|---|
| `internal/store/thread` | 260 s | 782 |
| `internal/store/plugin` | 179 s | 138 |
| `internal/store/project` | 101 s | 194 |
| `internal/db` | 39 s | 29 |

The frontend's checks took 85 s and go-lint 45 s cold, 2 s warm.

`go test` runs packages side by side but one package's tests one after another, and no
test in the three big packages calls `t.Parallel`. So a check was as long as `thread`.
There is no short list of slow tests to fix there: its 20 slowest are 38% of its time,
and the rest is hundreds of tests under a second each.

## Decisions

- **The three packages run as groups of `go test -run`, side by side**
  (`scripts/go-test.sh`, called by `make go-test`). The script lists a package's tests,
  examples and fuzz seeds, deals them into N groups, and starts one `go test -race -run
  '^(A|B|…)$'` per group, next to one `go test` for every other package and one for
  `pluginsdk`. Each group is its own process, which is the isolation packages already
  have from each other, so no test changed. The script fails if the groups do not hold
  every listed test.
- **Through `go test`, not a compiled test binary.** `-run` is a cacheable flag, so an
  unchanged package's groups are served from the test cache like any package. Running
  the binary directly (the first trial did) would re-run them on every check.
- **4, 4 and 3 groups on a 12-core machine, fewer on fewer cores.** At 6, 6 and 4 the
  split packages alone were faster (thread 58 s) but the whole run saturated the machine
  (load 21 to 27): CPU-bound packages doubled (`internal/db` 39 s to 128 s,
  `pluginsdk/ui` 48 s to 136 s) and that is the load that makes timing tests fail. The
  count scales with the core count and one group means the plain run, so the 3-core
  GitHub runner runs the sweep exactly as before.
- **The frontend's checks stay after the Go tests.** Running them alongside was tried
  and dropped: six vitest tests failed for lack of CPU (one took 71 s), the same
  starvation the check lock exists to prevent, inside one check. The page library's
  rebuild also writes `internal/pagelib/dist`, which the Go build embeds, so it could
  not have run beside a Go compile in any case.
- **Output is per job, not interleaved.** Each group's output is kept and printed when
  all have finished; any failure fails the target.

## Numbers

Full `GOFLAGS=-count=1 make check`, same machine (12 cores), nothing else running:

| | Wall time | Result |
|---|---|---|
| Before (main, 41565ba25) | 439 s | green |
| Everything at once, 6/6/4 groups, frontend alongside | 164 s | red: 6 vitest tests |
| After: 4/4/3 groups, frontend after | 186 s | green |

The Go tests alone went from about 270 s to about 100 s. What bounds them now is
`internal/store/plugin` (two 21 s tests in one group), `pluginsdk/ui` and `internal/db`.

## Not done

- Groups are dealt by the order tests are listed, not by how long they take. Balancing
  by measured time would even them out (plugin's groups ran 34 s to 114 s).
- `t.Parallel` inside the packages would do the same without extra processes, but needs
  each test's isolation checked (package-level state, `t.Setenv`).
- The sweep on the runner is no faster: at 3 cores nothing is split.
- `GO_TEST_SPLIT=` (empty) runs every package whole, for comparing or for a suspected
  interaction between groups.
