# gh events 4: plugin authors' feedback (2026-10-18)

Feedback from the test-watcher and gh-actions plugin authors on the events from
gh-events-1/2/3: one daemon fix (save temp files in `worktreeFilesChanged`) and a batch of
corrections to the plugin skill's events docs. Daemon and skill only; no GUI.

## What changed

| File | Change |
|---|---|
| `internal/store/project/files.go` | `fileOpFor` returns 0 (left out) for a file created and gone in the window that `seen` never had; `resolveFiles` drops those and transient directories with nothing listed under them |
| `internal/store/project/files_test.go` | `TestFileOpFor` cases, `TestResolveTransient` (table), a temp-file-only step in `TestFilesEventLiveOnly` |
| `proto/codefoundry/v1/project.proto` (+ generated) | comments on `WorktreeFilesChanged` and `FILE_OP_REMOVED` |
| `internal/command/commands_pr_checks.go` | the description said "Cached like the PR panel"; the panel reads another cache |
| `internal/skills/.../host-api.md` | the corrections below |
| `docs/notes/gh-events-1-…`, `gh-events-2-…` | which cache keeps what fresh; the created+removed decision and the bsdtar gotcha |

## Save temp files

BSD `sed -i` and most editors' atomic saves write a temp file (`.!47037!calc_test.go`)
and rename it onto the target, so a one-file edit arrived as two entries: the temp path
`removed` and the file `modified`. Rule: a path whose events carried a create, that is
gone when the window closes, and that this worktree never reported as existing (`seen`)
is left out: no consumer ever saw it exist. Still `removed`: a path there before the
window (no create flag), and a reported one (in `seen`, whatever its flags). Dropped
paths never reach `git check-ignore` (it gets `resolveFiles`' output) and are forgotten
from `seen`.

Directories are never in `seen` (created ones are not listed), so a created-and-gone
directory is left out only when nothing under it is listed either: `mkdir t; touch
t/x; rm -rf t` in one window sends nothing, while a directory made a few seconds ago
whose reported files are removed now (cumulative flags still say created) keeps `sub/`
beside its removed files. `resolveFiles` walks the sorted list backwards for this: a
directory's entries follow it.

### Before and after

Isolated daemon (`CODE_FOUNDRY_HOME=~/.cf-fb-home`, every `CLAUDE*` variable unset,
`daemon --dev`), scratch repo `~/cf-fb-scratch` (tracked `calc.go`, `calc_test.go`), a
thread on it (`thread new --project cf-fb-scratch --name fb --created-by=`, no prompt),
`events --json --source project`, 2.5 s between steps. The same script with the binary
built from main and from this branch (projectId, path and epoch cut):

```
# 1. echo >> calc_test.go (reports it)                     both
{"files":[{"path":"calc_test.go","op":"FILE_OP_MODIFIED"}]}
# 2. sed -i '' 's/TestAdd/TestAddition/' calc_test.go
before {"files":[{"path":".!95552!calc_test.go","op":"FILE_OP_REMOVED"},{"path":"calc_test.go","op":"FILE_OP_MODIFIED"}]}
after  {"files":[{"path":"calc_test.go","op":"FILE_OP_MODIFIED"}]}
# 3. sed -i '' 's/Add(/Sum(/' calc.go (never reported)
before {"files":[{"path":".!95556!calc.go","op":"FILE_OP_REMOVED"},{"path":"calc.go","op":"FILE_OP_CREATED"}]}
after  {"files":[{"path":"calc.go","op":"FILE_OP_RENAMED"}]}     (CREATED in another run)
# 4. rm calc.go                                              both
{"files":[{"path":"calc.go","op":"FILE_OP_REMOVED"}]}
# 5. tar xf of 20 files into pkg/
before 41 entries: pkg.qReRkV removed, then pkg/f01.txt created, pkg/f01.txt.3SiWo5 removed, …
after  20 entries: pkg/f01.txt … pkg/f20.txt, all created
```

Daemon debug lines (`worktree files changed`) after: step 2 `collected=2 kept=1`, the
untar `collected=42 kept=20`. No WARN or ERROR.

A second run with this branch checked the docs' claims: `mkdir -p sub/deep` with two
files (both `created`), then `rm -rf sub` 2.5 s later listed `sub/`, `sub/a.go`,
`sub/deep/`, `sub/deep/b.go`, all `removed` (the directories still carried their create
flags: the reported files under them kept them listed); an edit plus `git commit -a`
sent `calc.go` `modified` and a `worktreeUpdated` with the new head; `git commit
--allow-empty` sent only `worktreeUpdated`.

## Skill corrections (`host-api.md`)

* **Directories**: "its files are not listed then" was wrong for a removed directory:
  `rm -rf sub` lists `sub/` and every file under it. Only a directory moved in or out
  lists only itself.
* **Commits**: a commit sends no files event (only `.git` changes); its new head comes as
  `worktreeUpdated`.
* **`truncated`** is still a change: a watcher can just re-run; `git status` is for a
  consumer that needs the list.
* **Resync**: the first snapshot is not a resync; a later one means events were lost.
* **Snapshots per source** (`internal/api/events.go`): `threadList`, `project`,
  `workspace`, `gitops`, `action`, `plugin` send one `snapshot` object, `thread` a
  `pendingSnapshot`, `settings` only ever snapshots; `gh` sends `viewerUpdated`, `polled`,
  `dashboardUpdated` and a `repoActivityUpdated` per repository, each with `ev.Snapshot`
  true; `update` its `status`.
* **`threadList.updated.branch`** is the branch Code Foundry made the thread's worktree on
  (`Thread.branch`, empty for an existing checkout); the current branch is the `project`
  source's `worktrees[].branch` by `worktreePath`.
* **`CHECKS` gaps**: a rerun ending with the rollup it had (failure 1/1 → 1/1), or a run
  that starts and ends between two polls, sends no `CHECKS` change; a plugin that reran a
  run follows it itself. After a push, a `when` on `pr.checks.*` can read "not known
  yet" for seconds the first time it is asked with no GUI: retry.
* **Which cache is fresh how**: the `pr.checks` command reads `gh.Service.PullRequest`
  (`commands_pr_checks.go` → `GhService.GetPullRequest`); its freshness after an event is
  `detail_moved.go` (a copy fetched before the poll saw the pull request move is
  refetched). The plugin store's `checksCache` (and `InvalidatePullRequestChecks`) only
  feeds the `pr.checks.*` facts in `when` clauses (`pluginfacts.go`
  `PullRequestChecks`), whose own fetch goes through `gh.Service.PullRequest` too. The
  skill now says the command's freshness and points at `manifest.md` for the facts'; the
  gh-events-1 note credits each.
* **`worktreeUpdated.status` names**: the skill's (`modified, staged, untracked,
  conflicted, …`) match `GitStatus` in `project.proto`; the test-watcher's old struct
  (`added`, `deleted`, `renamed`, `conflicts`) was the stale one. No change.

## Not changed

* **An atomic save of a never-reported file** is `created` or `renamed` (step 3), not
  `modified`: the target is a new inode born now, and whether its events carry
  `ItemCreated` varies run to run. Telling it apart needs the index or a stat from before
  the window; the skill already says to treat the three alike.
* **A file created within ~40 s of the worktree going live, never reported, then
  removed** is now left out (cumulative flags still say created, and a gone file has no
  birth time to check). Rare: the thread must have started in between.
* **`host-api.md` is at 32,655 of 32,768 rendered bytes** (`maxPluginFile`). To fit, the
  pr.checks paragraph and the events intro were tightened. The next addition there needs
  to move something out (the per-file events section would make a reference of its own).

## Gotchas

* `code-foundry commands` starts a daemon for the `CODE_FOUNDRY_HOME` it runs with; a
  probe with a throwaway home leaves one running.
* The skill byte limit counts the rendered file (`{{cf.eventVariants}}` filled), about
  2 KB more than the source.
