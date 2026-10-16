# Faster `go test -race`: fake claude binary and a migrated template database

`internal/store/session` took 216 s under `-race` on the macOS runner and 165 s on a
laptop, but 20 s without `-race`. The per-test times summed to 20 s in both cases, so
the suite was not waiting on sleeps; it was paying race overhead somewhere else.

## What it was

- **Process starts.** The fake `claude -p` was the test binary re-executing itself
  (`Options.Claude = os.Args[0]`). A race-instrumented binary takes about 1.3 s to start
  on macOS arm64 (0.3 s uninstrumented): the race runtime reserves its shadow memory at
  startup. The suite starts a few hundred fake claudes. This was 100 s of the 165.
- **Migrations.** Each test env opened a fresh database and applied all 21 migrations
  through modernc sqlite, whose SQL parser under `-race` (checkptr on every pointer) took
  about a quarter of a second per database. 27 of the remaining 66 s, per pprof.

## Decisions

- **`cmd/fakeclaude` + `internal/claudestream/fakeclaude`.** The fake moved out of the
  test file into a library package (so `Spawn` and `InitCommands` stay shared with the
  tests) and a main. `TestMain` builds it once per run with `go build` into a scratch
  dir (cached by the build cache, pure Go, about a second cold) and the tests point
  `Options.Claude` at it. `go test` subprocesses do not inherit `-race`, so the fake is
  uninstrumented. It is not shipped: `make build` and `scripts/package.sh` name their
  packages.
- **`internal/db/dbtest`.** `dbtest.Path(t)` writes a copy of a once-per-process
  migrated database under `t.TempDir()`; `db.Open` on it finds every migration applied.
  The template is built from an empty file through the real `db.Open`, WAL checkpointed
  and truncated, and held as bytes (no stray temp files). All five stores' tests use it.
  Migration behaviour itself is still covered by `internal/db` and by the template build.

## Results (`go test -race`, laptop)

| package   | before | after |
|-----------|-------:|------:|
| session   | 165 s  | 23 s  |
| repo      | 36 s   | 23 s  |
| action    | 13 s   | 4 s   |
| workspace | 9 s    | 3 s   |

`repo` is now bound by its real git operations (21 s without `-race` too).

## Also in this change

`TestStreamHeartbeats/.../real events reset the timer` failed on the first main run
after #137: on a loaded runner under `-race` the 20 ms poke ticker was starved past the
100 ms heartbeat interval. It now pokes every 10 ms and allows one heartbeat in five
intervals (a stream that ignored events would send five).

## Gotchas

- `TestMain` needs `go` on PATH. Fine locally and on the runners; a sandbox without it
  fails the package at startup with a clear message.
- The template's `schema_migrations` rows carry the time the template was built, not the
  test's. Nothing reads them.
