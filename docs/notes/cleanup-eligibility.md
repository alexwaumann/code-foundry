# Cleanup eligibility

Follow-up to the 2026-10-18 orchestration experiment (REPORT.md C1; w2e finding 1, w2b
finding 4). Two holes in `project.worktree.cleanup`:

- "Made by Code Foundry" was path-based (`Managed`: under the worktrees directory), and a
  branch with zero commits past origin/<default> has `BaseAhead 0`, so it counted as
  merged. One orchestrator's `cleanup --yes` deleted another's three 3-second-old
  hand-made worktrees under that directory.
- A child branch whose rebased copy the orchestrator merged is never an ancestor of
  origin/main, so its worktree was stranded for good.

## The rule now (`project.CleanupVerdict(w, now)`, table-tested)

Removable, in order of the checks: not main; **made by Code Foundry** (recorded, see
below); on a branch; status read, no error, no operation, nothing uncommitted; a base ref;
**not made less than 10 minutes ago with HEAD still at the commit it was made at**; and its
work is in origin/<default>:

| why it can go | when |
|---|---|
| `branch is in origin/main` | `BaseAhead 0`, HEAD moved since it was made |
| `no commits since it was made` | `BaseAhead 0`, HEAD unchanged, older than 10 minutes |
| `a rebased or squash-merged copy is in origin/main` | `BaseAhead > 0` and `Status.BaseMerged` |

The verdict returns the reason either way; `CleanupResult.Removed` and the proto's
`CleanupWorktreesResponse.removed` (now `RemovedWorktree {worktree, reason}`, field 2
reserved) carry it. The hold (thread, terminal, workspace) still applies after a
removable verdict.

## Decisions

- **Records, not a thread-store callback.** The brief allowed a callback over thread rows
  with `CreatedWorktree`. Every worktree the app makes goes through
  `project.Git.CreateWorktree` (new-worktree threads, workspaces, recreate on resume,
  `project.worktree.new`, PR threads), so the project store records it there
  (`project_worktrees`: path, project, HEAD right after, time; `made.go`). That covers
  `project.worktree.new` (no record existed for it before), archived and removed threads,
  and gives the exact creation HEAD for the "no commits yet" test. No store imports
  another. Migration 0035 backfills from thread rows that made their worktree (archived
  included, earliest thread time per path, head unknown). Legacy worktrees made by
  `project.worktree.new` without a thread were never recorded anywhere: they become "not
  a Code Foundry worktree" (kept; removable by hand). Safe direction.
- **Record lifetime.** Dropped by `RemoveWorktree`, and by a reconcile whose listing no
  longer has the path (only rows made before the listing started, so a worktree made
  meanwhile is not dropped). Otherwise a CF worktree removed by hand and later re-added by
  hand at the same path would inherit the record. Rows outlive `Unregister` (a project
  registered again keeps its worktrees cleanable).
- **Merged by content = a no-op merge, not tree equality.** `git diff --quiet origin/main
  <branch>` only holds when the copy was the last thing merged. `git merge-tree
  --write-tree origin/main <branch>` giving origin/main's own tree holds after later
  merges too, and covers squash merges and GitHub "rebase and merge". A copy whose
  conflict resolution changed the branch's lines (w2b's exact case) is still not
  recognised: nothing can tell that from lost work. Old git (< 2.38) falls back to tree
  equality.
- **Where BaseMerged is computed.** In the status job, memoized with the base counts by
  (HEAD, base sha), and only when HEAD is both ahead and behind (no copy can have landed
  otherwise). So the dry run, the GUI's `merged_clean` "in main" tag and the cleanup
  count all agree with the real run, and the cost is one `rev-parse` + one `merge-tree`
  per worktree per base or HEAD move.
- **The 10-minute grace keys on HEAD, not on BaseAhead.** A worktree just made from an
  existing branch whose copy landed is kept too (someone just asked for it). A fresh
  worktree that already committed and merged goes at once.
- **Confirmation text.** Without `--yes` the prompt lists every worktree that would go and
  every one kept, one per line with branch, path and reason; for one path it names that
  worktree and its reason either way. The confirm dialog now keeps line breaks
  (`whitespace-pre-line`, scrolls past `max-h-96`). The command description had to stay
  short: the agent guide has a 29,000-byte cap (`internal/guide`).
- The skill files were not touched (another PR owns them).

## Gotchas

- `git merge-tree --write-tree` writes the merged trees and blobs as loose objects even
  when it only reports; a no-op result writes nothing new, others are unreachable and
  pruned by gc. Hence the ahead-and-behind gate and the memo.
- `TestDetailCache/base moved by fetch` counts git calls per job; a worktree ahead and
  behind now adds `rev-parse` + `merge-tree` to its status job.
- Running `make build` while `make check` downloads zig corrupts `third_party/zig`;
  delete it and build again.

## End to end (isolated daemon, `CODE_FOUNDRY_HOME=/tmp/cleanelig-home`, Haiku 5.5)

Project `cleanelig2-todo` (origin a bare clone of the todo template). Two Haiku threads
with `--new-worktree` each committed one change. In the main checkout: `git merge
--no-ff cf/merged-child`; then, as in w2b, `git checkout -b rebase/rebased-child
cf/rebased-child && git rebase main`, merge that copy, delete it, push (cf/rebased-child
stays at the pre-rebase d58eefa). A hand-made `git worktree add -b by-hand
<home>/worktrees/_local/cleanelig2-todo/by-hand origin/main`, as P1 did in w2e.

With the two threads still live:

```
$ code-foundry project worktree cleanup 9ebedc2d68c4
code-foundry project.worktree.cleanup: Fetch and remove the worktrees Code Foundry made whose work is in the default branch? None would be removed now; each is checked again after the fetch.
Keep 3:
- by-hand at /private/tmp/cleanelig-home/worktrees/_local/cleanelig2-todo/by-hand: not a Code Foundry worktree
- cf/merged-child at /private/tmp/cleanelig-home/worktrees/_local/cleanelig2-todo/cf-merged-child: thread merged child is on it
- cf/rebased-child at /private/tmp/cleanelig-home/worktrees/_local/cleanelig2-todo/cf-rebased-child: thread rebased child is on it
Re-run with --yes to confirm.
```

Both archived, plus a third Haiku thread ("Reply OK, no tools") in a new worktree,
archived, so a zero-commit CF worktree with an archived thread:

```
01:22:00 $ code-foundry project worktree cleanup 9ebedc2d68c4
code-foundry project.worktree.cleanup: Fetch, then remove 2 worktrees (branches are kept; each is checked again after the fetch):
- cf/merged-child at .../cleanelig2-todo/cf-merged-child: branch is in origin/main
- cf/rebased-child at .../cleanelig2-todo/cf-rebased-child: a rebased or squash-merged copy is in origin/main
Keep 2:
- by-hand at .../cleanelig2-todo/by-hand: not a Code Foundry worktree
- cf/fresh-child at .../cleanelig2-todo/cf-fresh-child: no commits yet, made less than 10 minutes ago
Re-run with --yes to confirm.

01:22:00 $ code-foundry project worktree cleanup 9ebedc2d68c4 --yes
Removed 2 worktrees: cf/merged-child (branch is in origin/main), cf/rebased-child (a rebased or squash-merged copy is in origin/main); kept 2 worktrees: by-hand (not a Code Foundry worktree), cf/fresh-child (no commits yet, made less than 10 minutes ago)

$ git worktree list    # branches cf/merged-child and cf/rebased-child still exist
/Users/alex/cf-exp-scratch/cleanelig2-todo                                   27973a4 [main]
/private/tmp/cleanelig-home/worktrees/_local/cleanelig2-todo/by-hand         27973a4 [by-hand]
/private/tmp/cleanelig-home/worktrees/_local/cleanelig2-todo/cf-fresh-child  27973a4 [cf/fresh-child]
```

The same scenario on a first project (`cleanelig-todo`, fresh-child made 01:13:26),
after a daemon restart (the record survived it) and past the 10 minutes:

```
01:25:09 $ code-foundry project worktree cleanup f64320437671 --yes
Removed 1 worktree: cf/fresh-child (no commits since it was made); kept 1 worktree: by-hand (not a Code Foundry worktree)
```

Tests: `TestCleanupVerdict` (table: hand-made, zero commits at 1 min / 9m59s / 10 min /
1 h, head unknown, rebased, squashed, ahead-and-behind not landed, ...),
`TestCleanupRealProject` (real git: merged, rebased copy, squash, dirty, unmerged, held,
fresh, hand-made under the root and elsewhere; fresh goes once `Now` is 11 min later),
`TestMadeWorktreeRecords` (survives restart; dropped once git no longer lists it; a
hand-made worktree at the same path is not managed), the 0035 backfill test, the command's
prompt test, and the Projects e2e (`projects.spec.ts`, 24 passed).
