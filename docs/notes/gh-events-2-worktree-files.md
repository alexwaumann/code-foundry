# Per-file worktree change events

Status: done. `make check` is green. Verified end to end with an isolated daemon
(`CODE_FOUNDRY_HOME=~/.cf-wtf-home`, `daemon --dev`, every `CLAUDE*` variable unset), a
scratch repo under `~`, and a thread on it so its worktree was live.

PR B of three (A: gh `pullRequestChanged`; C: PR wake target + skill, on A). Daemon + CLI
only; the GUI ignores the new variant (`toProjectEventView` returns null for unknown
cases already).

## Why

The test-watcher plugin polls `git status --porcelain` and file mtimes every 2 s because
`worktreeUpdated` only fires when a worktree's status *counts* change: a second edit to a
modified file sends nothing. The store already sees every edit (one FSEvents stream,
per-file events) and threw the path away.

## What changed

| File | Change |
|---|---|
| `internal/store/project/files.go` (new) | `WorktreeFilesChanged`, `ChangedFile`, `FileOp`; the collector (`fileCollector`), op decision (`fileOpFor`, `dirOpFor`, `resolveFiles`), cap, `flushFiles` (the files job), `dropIgnored` |
| `internal/store/project/fsevents.go` | `onEvents` also hands each tree hit of a live worktree to the collector and triggers its `jobFiles` key on `treeDeb` |
| `internal/store/project/sched.go`, `store.go` | `jobFiles`; `runJob` runs it; `Git.files` |
| `internal/store/project/activity.go` | `isLive` |
| `internal/store/project/runner.go` | `InputRunner` (`ExecRunner.RunInput`: `Run` with stdin) and `runInput` |
| `proto/codefoundry/v1/project.proto` | `ProjectEvent.worktree_files_changed` (7), `WorktreeFilesChanged`, `ChangedFile`, `FileOp` |
| `internal/api/project_files.go` (new), `project.go` | the mapping, used by ProjectService.Watch, EventService and so plugin feeds |
| `internal/store/project/projecttest/files.go` (new) | `Fake.FilesChanged` |
| `internal/skills/.../host-api.md` | "No per-file events" becomes "Per-file events"; payload table row. The variants table (`{{cf.eventVariants}}`) reads the oneof and picks the new case up by itself |

## How it works

* **Collect** (dispatch goroutine, no git): `eventKeys` already reports a tree hit (nearest
  known directory is a worktree root, action status). For those, if the worktree is in
  the live set, `treeFile` makes the path worktree-relative (forward slashes) and drops
  the root itself and anything with a `.git` component (a nested repo's or submodule's
  git dir; the worktree's own git dir routes to a git-dir kind and never is a tree hit).
  The collector ORs the event's ops per path and records the path's first event time.
  Rescans (`MustScanSubDirs` etc.) are not tree hits: no list, they reconcile as before.
* **Window**: the `jobFiles` key is triggered on `treeDeb`, so its timer is armed by the
  same first event as the status job's and closes at the same time (1 s). The job then
  runs on the store's workers; events arriving while it runs go to the next window.
* **Flush** (`flushFiles`, a worker): take the window, `lstat` each path, decide its op,
  sort by path, one `git check-ignore --stdin -z` (index respected, `GIT_OPTIONAL_LOCKS=0`
  from `gitEnv`), cap at 500, publish under `pubMu` so it is ordered with the snapshot
  events. Nothing is published when every path was ignored. A worktree gone from the
  store drops its window and memory.
* **Bounds**: at most `maxPendingFiles` (10 000) paths collected per window; beyond that
  the flush is `Truncated`. One check-ignore process per worktree per window.

## Decisions

* **Op = what is there when the window closes.** Not there: `removed` (the old side of a
  rename is removed). There: `created`, `modified` or `renamed`. Last op wins falls out
  of it. A path created and gone in one window that was never reported (not in `seen`)
  is left out entirely since gh-events-4 (`docs/notes/gh-events-4-feedback.md`): save
  temp files.
* **FSEvents flags are cumulative** (`fsevents-watcher.md`). Probed: an append to a file
  created 0, 2 and 10 s earlier still carried `ItemCreated`; at 40 s it did not. So
  `created` needs three things: a create flag, a path this worktree has not reported as
  existing in the last 10 min (`seen`, per worktree, capped at 20 000), and a *fresh*
  file: born at most 1 s before its first event, or with a birth time equal to its mtime.
  The last one is the untar case: setting a file's mtime into the past pulls macOS's birth
  time back to it (checked with `touch -t`), so extracted and `cp -p` files are old by
  birth time but equal. A seen path is always `modified`, whatever its flags.
* **`renamed`**: an existing path with a rename flag that is not fresh-created and not
  seen. An atomic save (temp file renamed onto the target) of a file not reported yet
  shows as `created`; of a reported one, as `modified`.
* **Directories** are listed (with a trailing `/`) only when removed or renamed in: a
  directory moved in or out has no events for its files. Created or modified directories
  are left out (their files have their own events). The `/` also makes check-ignore match
  directory-only patterns (`build/`) for a directory that no longer exists.
* **Submodules**: `git check-ignore` dies with `fatal: Pathspec 'x' is in submodule 's'`
  for a path inside one, and with `beyond a symbolic link`. `dropIgnored` drops the
  refused path (for a submodule, everything under it) and runs again, at most 4 more
  times; past that, or on any other error, the window is dropped with a warning (status
  shows the git error). So paths inside submodules are never listed.
* **No stdin in `Runner`**: added `InputRunner` as an optional interface beside it rather
  than changing `Runner`'s signature (many call sites, test wrappers). A runner without
  it makes the flush fail with a warning; only test wrappers lack it.
* **Live worktrees only** (`SetLiveWorktrees`: a thread that is not archived or snoozed).
  A worktree whose detail was opened recently is on the live *poll* tier but sends no
  file lists. Idle worktrees keep their status jobs.
* **Naming**: `FileChange` was taken (worktree detail, in Go and proto), so the entry is
  `ChangedFile` and the enum `FileOp`.

## End to end

`code-foundry events --json --source project` against the scratch repo (`.gitignore`:
`bin/`, `*.log`, `node_modules/`), ~2.5 s between steps:

```
# 1. append to tracked src/main.go
{"project":{"worktreeFilesChanged":{"projectId":"92a7caac4dfd","path":"/Users/alex/cf-wtf-scratch","files":[{"path":"src/main.go","op":"FILE_OP_MODIFIED"}]}},"seq":"1","epoch":"16a5f86fddab"}
{"project":{"worktreeUpdated":{…"status":{"modified":1,"dirty":true,…}}},"seq":"2",…}
# 2. new untracked src/new_test.go
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"src/new_test.go","op":"FILE_OP_CREATED"}]}},"seq":"3",…}
{"project":{"worktreeUpdated":{…"status":{"modified":1,"untracked":1,…}}},"seq":"4",…}
# 3. append to it again: counts unchanged, so no worktreeUpdated
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"src/new_test.go","op":"FILE_OP_MODIFIED"}]}},"seq":"5",…}
# 4. mkdir bin; write bin/app and debug.log (all ignored): nothing at all
# 5. mkdir -p pkg/a/b; write pkg/a/b/deep.go and bin/deep.o
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"pkg/a/b/deep.go","op":"FILE_OP_CREATED"}]}},"seq":"6",…}
{"project":{"worktreeUpdated":{…"untracked":2,…}},"seq":"7",…}
# 6. mv src/new_test.go src/renamed_test.go; rm README.md
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"README.md","op":"FILE_OP_REMOVED"},{"path":"src/new_test.go","op":"FILE_OP_REMOVED"},{"path":"src/renamed_test.go","op":"FILE_OP_RENAMED"}]}},"seq":"8",…}
{"project":{"worktreeUpdated":{…"modified":2,"untracked":2,…}},"seq":"9",…}
# 7. mv pkg pkg2
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"pkg/","op":"FILE_OP_REMOVED"},{"path":"pkg2/","op":"FILE_OP_RENAMED"}]}},"seq":"10",…}
# 8. tar xf of 1000 files into pkg/: one event, truncated
{"project":{"worktreeUpdated":{…"untracked":1002,…}},"seq":"11",…}
{"project":{"worktreeFilesChanged":{…,"files":[{"path":"pkg.k6fzK1","op":"FILE_OP_REMOVED"},{"path":"pkg/f0001.txt","op":"FILE_OP_CREATED"},{"path":"pkg/f0001.txt.9Y9FxH","op":"FILE_OP_REMOVED"},… 500 entries, last "pkg/f0250.txt" …],"truncated":true}},"seq":"12",…}
# 9. archive the thread (live worktrees: 0), edit src/main.go, add idle_new2.go
{"project":{"worktreeUpdated":{…}},…}            # and no worktreeFilesChanged
```

Daemon debug lines for the same run (`worktree files changed`): step 4 `collected=3
kept=0` (`bin/` created is a directory, the other two ignored), step 5 `collected=5
kept=1`, the untar `collected=2002 kept=500 truncated=true`.

**check-ignore cost**: 7 to 23 ms per flush for 1 to 5 paths, 13.5 ms for the 2002-path
untar (one process each time; the timing includes the fork/exec).

## Gotchas

* **bsdtar extracts through temp names** (`f0001.txt.9Y9FxH`, then renamed onto
  `f0001.txt`), so an untar listed every file twice: the temp name `removed` and the real
  one `created`, halving what fits under the cap. Since gh-events-4 the temp names are
  left out (created and gone, never reported), and the cap holds 500 real files.
* **check-ignore stops at the first refused path** (submodule, symlink) with exit 128 and
  prints only the results before it; exit 1 means nothing was ignored.
* **The stream's "since now" start replays** a recent event for a file written just
  before the stream started (seen in the flag probe). Harmless: it is one more edit.

## Tests

* `files_test.go`: `TestTreeFile`, `TestFileOpFor`, `TestResolveFiles` (merging, seen,
  stale create flag, untarred file, directories), `TestCollectorOverflow`, `TestCapFiles`,
  `TestSeenOfPrunes`, `TestDropIgnored` (real repo: tracked file matching a pattern,
  ignored dirs for existing and missing paths, all ignored, submodule refusal),
  `TestFilesEventLiveOnly` (store + synthetic events: idle sends nothing, live sends,
  ignored-only sends nothing, 550 paths truncate to the first 500, unlive sends nothing),
  `TestStreamFilesEvent` (real FSEvents: nested new file, edit with a stale create flag,
  an archive-dated file, ignored dir left out; 20 s deadline).
* `internal/api`: protojson of the mapping; the EventService order test carries it.
* `cmd/code-foundry`: `eventLine` row; `events --json --source project` round trip.
