# Rescans refresh statuses again; per-worktree poll tiering

Branch `fix/project-rescan-and-idle-poll`, two commits: the rescan fix (part 1), then the
poll tiering (part 2), which relies on it.

## Part 1: a rescan or a config rewrite refreshed no status

Since #897 (`perf-project-sched-fetch-fsx.md`) `resolveBase` fans out a status job to
every worktree only when origin/<default> moved. Before it, every reconcile ended in
"base, then every status", and three event paths relied on that without saying so:

- **Rescans.** FSEvents dropping or coalescing events (`MustScanSubDirs`, `UserDropped`,
  `KernelDropped`, `RootChanged`, mounts) mapped to `jobReconcile` only. After #897 no
  status ran, so edits, HEAD moves and ahead/behind made while events were being dropped
  (a heavy install or build: `project-watcher-tests.md` measured 13 to 21 rescan
  batches in 15 s of churn) stayed stale until the next poll (5 or 15 min) or a thread's
  Touch.
- **config** (and `config.lock` created): `git branch -u`, `git push -u`, a remote
  change. A reconcile re-reads remotes but not upstreams, which only a status reads.
- **packed-refs** already had a patch in `onEvents` that queued every status.

Reproduced first with `rescan_test.go` against `53bdc30df`:

```
--- FAIL: TestRescanRefreshesStatus (8.87s)
    rescan_test.go:37: timed out waiting for the side worktree's edit after a rescan
--- FAIL: TestConfigRewriteRefreshesUpstream (5.72s)
    rescan_test.go:69: timed out waiting for the new upstream after a config rewrite
```

### The fix

`eventKeys` (watch.go) now returns the statuses with the reconcile, so the rule is in
one pure function and table-tested (`TestEventKeys`), and the `packed-refs` special case
in `onEvents` is gone (it is one of the three cases now):

- `packed-refs`, `config`, `config.lock` created in the common dir: reconcile and the
  status of every worktree of the project (from the routing table's worktree roots).
- A rescan (`rescanKeys`): reconcile every project with a known directory at, above or
  below the path, as before, and refresh the worktrees whose events may be lost:
  - a worktree root at or below the path: that worktree;
  - the path inside a worktree's tree (its nearest known directory above is the root):
    that worktree only, since dropped edits in its files change nothing else;
  - a git admin dir (common dir, logs, remote refs, `worktrees/`, a linked admin dir) at
    or below the path, or the path inside one: every worktree of the project, since a
    dropped `packed-refs`, `config` or remote-ref event can change any of them;
  - a project without git: the reconcile alone.

The spec asked for "every worktree of the affected projects". The narrowing above is
deliberate: the rescans seen under builds are either at a stream root (covering
everything anyway, or, at the managed worktree root, only the worktrees under it) or a
coalesced `MustScanSubDirs` on a busy directory inside one worktree
(`node_modules/...`), where refreshing all 41 siblings every 300 ms window would be the
cost #897 set out to remove.

### Cost

Per rescan batch, per covered project: the reconcile (as before; four small commands)
plus one `git status` (plus a memoized `rev-list` when HEAD moved) per refreshed
worktree. Rescan statuses go through the 300 ms git debouncer like the reconcile, so
under sustained rescans a worktree is refreshed at most once per 300 ms window (not the
1 s tree window: a rescan is not routed as a tree edit). Idle worktrees' statuses run at
low priority (`eventPrio`). A config rewrite costs one status per worktree; the
`config.lock` and the rename onto `config` normally fall in one debounce window. The
app's own `CreateWorktree` passes `--no-track` except when tracking `origin/<branch>`,
so it rewrites config only in that case.
