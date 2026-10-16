# Worktree operation state

A daemon-side PR that adds "a git operation is in progress" to each worktree's `GitStatus`,
so the worktree panel (a later GUI PR) can show a strip like "Rebase in progress ·
2 conflicts · step 3/6". This PR has no UI.

## Shape

- `GitStatus.operation` (14): "", `rebase`, `am`, `merge`, `cherry-pick`, `revert` or
  `bisect`. `operation_step` (15) and `operation_total` (16) are a rebase's (or am's)
  current and last patch, 1-based. Both are 0 when git does not record them: merge,
  cherry-pick, revert and bisect, and a rebase before its first pick.
- `operation_onto` was left out. The onto target is a sha in `rebase-merge/onto`, and
  naming it would mean guessing which branch it is (or running a git command).
  `head-name` is the branch being rebased, not the target.
- `repo.Status` gets `Operation`, `OperationStep` and `OperationTotal`. `equalIgnoringTime`
  compares by value, so an operation starting or ending publishes `WorktreeUpdated`.
- `GitStatusView` (`gui/frontend/src/api/repo.ts`) gains `conflicted`, which was in the
  proto but not mapped until now, plus `operation`, `operationStep` and `operationTotal`.
  They are optional like the `base*` fields, so existing fixtures still type-check.
- `MergedCleanReason` now returns "<op> in progress" when an operation is running. A rebase
  was already excluded because HEAD is detached. This also covers a bisect on a branch,
  and a `merge --no-commit` that left the tree clean. Cleanup never removes such a
  worktree.

## Zero extra git calls

The status job still runs exactly one `git status --porcelain=v2 --branch -z`, plus the
memoized base counts. Right after the porcelain parse it calls
`readOperation(slot.gitDir)` (`internal/store/repo/operation.go`), which only stats and
reads files in the worktree's admin dir. Missing files are the normal case: they return
the zero value and nothing is logged. There is no new scheduling and no new goroutine.

The admin dir is resolved once per slot by the reconcile job and cached in
`wtSlot.gitDir` (guarded by `Git.mu`, like `wtSlot.admin`):

- main worktree: `<path>/.git` when that is a directory (`worktreeAdminDir`). If it is a
  file (a separate git dir), it falls back to `readGitFile`.
- linked worktree: the `admins` map reconcile already builds with `readGitFile`.

There is no `git rev-parse --git-dir`.

## Markers (precedence follows git's own wt-status)

| Marker in the admin dir | operation | step / total |
|---|---|---|
| `rebase-merge/` (directory) | `rebase` | `msgnum` / `end` |
| `rebase-apply/` with `applying` | `am` | `next` / `last` |
| `rebase-apply/` without it | `rebase` (apply backend) | `next` / `last` |
| `MERGE_HEAD` | `merge` | 0 / 0 |
| `CHERRY_PICK_HEAD` | `cherry-pick` | 0 / 0 |
| `REVERT_HEAD` | `revert` | 0 / 0 |
| `BISECT_LOG` | `bisect` | 0 / 0 |

Rebase is checked first because its steps can leave `MERGE_HEAD` (`rebase -r`) or
`CHERRY_PICK_HEAD` behind. The e2e log shows `CHERRY_PICK_HEAD` coming and going during a
plain cherry-pick. Bisect comes last because it survives checkouts and can overlap the
others. A `rebase-merge` that is a file, not a directory, does not count as a rebase.

`am` is not in the original list. It shares `rebase-apply/` with the apply backend, so the
choice was to name it or mislabel it as a rebase. Naming it costs one `Stat`.

## Watcher: done (no new watch)

Both admin dirs are already watched non-recursively: `<common>` (`wkCommon`, main
worktree) and `<common>/worktrees/<name>` (`wkLinkedAdmin`). `classify` now maps a
create, remove, rename or write of any `operationMarkers` entry in those two kinds to
`actStatus` (debounced like everything else). That is three lines plus the shared marker
set in `operation.go`. A chmod-only event and `MERGE_HEAD.lock` still do nothing.
In practice HEAD, index and reflog events already fire on every operation start and
end; the markers make the trigger explicit rather than incidental.

Step changes inside `rebase-merge/` are not watched (it is a level deeper). Each step
commits, which appends to the reflog (`logs/HEAD`) and refreshes status, so step N/M
stays current. The 30 s poll is the backstop.

## Tests

- `operation_test.go`: a table over `t.TempDir()` fixtures for every marker layout,
  covering both rebase backends, am, the precedence cases, garbage counters, a stray
  `rebase-merge` file and "nothing in progress". Also `worktreeAdminDir` for main,
  linked and no-`.git` paths.
- `TestOperationStateThroughWatcher`: real git with the poll disabled. A conflicting
  `rebase main` in a linked worktree reports rebase 1/2 with `Conflicted == 1`, and
  `--abort` clears it. A conflicting merge in the main worktree reports merge, and
  `--abort` clears it. Each step is seen through the watcher alone.
- `watch_test.go` has classify rows for the markers. `cleanup_test.go` has the
  operation-in-progress reasons. `mapping.test.ts` covers the view mapping.

## End to end (2026-10-16)

`HomeRoot` is `$HOME`, so the daemon runs with `HOME` inside `/tmp` so that it accepts a
scratch repo there.

```sh
make build
mkdir -p /tmp/cf-opstate/home /tmp/cf-opstate/cfhome   # + a .gitconfig with user.name/email
export HOME=/tmp/cf-opstate/home
R=$HOME/scratch; git init -q $R && cd $R
echo base > a.txt && git add . && git commit -qm base
git checkout -qb feature
for i in 1 2 3 4 5 6; do if [ $i = 3 ]; then echo feature > a.txt; else echo $i > f$i.txt; fi; git add . && git commit -qm "feature $i"; done
git checkout -q main && echo main > a.txt && git commit -qam "main change" && git checkout -q feature

CODE_FOUNDRY_HOME=/tmp/cf-opstate/cfhome ./bin/code-foundry daemon --dev > /tmp/cf-opstate/daemon.log 2>&1 &
CODE_FOUNDRY_HOME=/tmp/cf-opstate/cfhome ./bin/code-foundry repo add $R

st() { buf curl --protocol connect --http2-prior-knowledge --unix-socket /tmp/cf-opstate/cfhome/daemon.sock \
  --schema proto -d '{}' http://localhost/codefoundry.v1.RepoService/List \
  | jq -c '.repos[0].worktrees[0] | {branch, detached, status: (.status | del(.refreshedAt))}'; }

(cd $R && git rebase main); st      # stops on "feature 3"
(cd $R && git rebase --abort); st
(cd $R && git merge main); st; (cd $R && git merge --abort); st
(cd $R && git cherry-pick main); st; (cd $R && git cherry-pick --abort); st
```

The daemon was never restarted. Each `st` ran about 1.5 s after the git command:

```
rebase:       {"branch":null,"detached":true,"status":{"dirty":true,"conflicted":1,"operation":"rebase","operationStep":3,"operationTotal":6}}
abort:        {"branch":"feature","detached":null,"status":{}}
merge:        {"branch":"feature","detached":null,"status":{"dirty":true,"conflicted":1,"operation":"merge"}}
abort:        {"branch":"feature","detached":null,"status":{}}
cherry-pick:  {"branch":"feature","detached":null,"status":{"dirty":true,"conflicted":1,"operation":"cherry-pick"}}
abort:        {"branch":"feature","detached":null,"status":{}}
```

The debug log shows the new classify rows firing, for example
`path=…/scratch/.git/rebase-merge op=CREATE kind=common action=status` and the matching
`REMOVE`, and the same for `MERGE_HEAD` and `CHERRY_PICK_HEAD`.

## Gotchas

- No CLI verb prints worktree status (`code-foundry status` is daemon health, and
  `repo list` exists only in an error hint), so the CLI part was skipped.
- `buf` is at `~/go/bin/buf` and may not be on `PATH` in a non-login shell.
- A status refresh that fails keeps the previous operation fields, like every other field
  ("stale when Error is set").
