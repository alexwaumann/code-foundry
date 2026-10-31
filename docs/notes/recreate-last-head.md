# Recreate a removed worktree on its last HEAD

Follow-up of `docs/notes/thread-checkouts.md` (both of its follow-ups). A worktree-mode
checkout whose branch moved (X, the created-for branch, to Y) and that a cleanup then
removed used to come back on X. Now it comes back on Y, at the same path.

## Rules (agreed with the project owner)

- The branch is the one the worktree had checked out when the cleanup removed it, while
  it exists: the local branch, else origin's (remote-tracking ref, else the targeted
  fetch), the lookup recreate already used. Gone everywhere: the old behaviour (X, then
  the base).
- Members (`ensureMembers`) follow the same rule.
- The note names the branch checked out and, when it is not X, says so in one clause:
  "... recreated from branch Y, where this thread had moved from X."
- Nothing recorded (rows from before, a worktree removed by hand or by
  `project worktree remove`): unchanged.

## Decisions

- **HEAD was not recorded anywhere.** PR #401 records each checkout's path. HEAD is a
  live fact read from the project snapshot, which drops it with the worktree. So the
  cleanup records it: `thread.Manager.RememberHead` runs in `project.CleanupOptions.Removing`
  (the daemon's `beforeRemoval`, with the leftover-process log), right before each removal.
  `project.Cleanup` refreshes first, so the HEAD is current. Both cleanups go through it:
  `project worktree cleanup` with the abandoned sweep (api), and the archive / remove /
  unregister cleaner (`archiveCleaner.remember`).
- **Migration 0051 `threads.last_heads`**: a JSON `{project_id: branch}`, `''` for nothing,
  written whole with the row like `checkouts`. A new column was needed because the record
  must survive a daemon restart between the cleanup and the next start (the e2e restarts
  there). Only an entry that differs from X is kept; a detached HEAD or X drops it. Fork
  copies it, removing a member drops its entry, and a start that makes the checkout again
  (or takes over another one) drops it, since HEAD is live again.
- **`CreateWorktreeOptions.Path`** (project store): the default path depends on the
  branch, so making Y at X's path needs an explicit path. It must be inside the
  worktrees root (`ErrInvalidArgument` otherwise). It is passed only when recreating on
  the last HEAD; the created-for path is unchanged, `samePath` guard included.
- **Y checked out in the project's main checkout**: fall back to X (logged). We never make
  a second worktree on one branch.
- **Members**: those with a last HEAD are handled one by one (`remakeOnHead`, under the
  per-(project, branch) lock) before the parallel `makeWorktrees` on X for the rest. If
  another linked worktree has Y checked out, the thread takes it over, since git allows
  one worktree per branch.
- **Takeover note** (the second follow-up, small): when a member made again lands on another
  linked worktree on the branch (Y, or X with nothing recorded) at a different path than its
  recorded one: "The worktree of project P this thread worked in (A) was removed, and
  another worktree has branch B checked out (C), so the thread now works there."
- When Y is gone and the fallback is used, the note is the old one (it names X); the log
  says Y was gone.

## Gotchas

- If a removal fails after `Removing` ran, the entry stays while the worktree still
  exists. It is used only once that checkout is missing again, so a later hand removal
  after another switch would bring back the older branch. Accepted: rare, and the branch
  still exists.
- `project worktree remove` (explicit) does not record HEAD. It is not a cleanup and
  may delete the branch.
- In the e2e, the archive cleanup removed the clean worktree on its own, before
  `project worktree cleanup` could. The second round leaves an untracked file so the
  archive keeps it and `project worktree cleanup --force` removes it.

## Tests

`TestRecreateBranch` (Y local, Y only on origin, Y gone with X local / X only on origin /
both gone, not recorded, Y == X), `TestRememberHead` (moved, X, detached, another path,
another project; persisted), `TestSendRecreatesOnLastHead` (local, origin, after a fetch,
gone, Y in the main checkout: the CreateWorktree options and the note),
`TestStartRemakesMemberOnLastHead` (member on Y at its path, not recorded, takeover on Y
and on X), `TestRemadeNote` (moved case), `TestCreateWorktreeAtPath`,
`TestThreadLastHeadsMigration`, `TestArchiveCleanup` (remember called for each removed
worktree with its branch).

## Verified

- `make check` green.
- Isolated `CODE_FOUNDRY_HOME`, a local bare origin + clone under `$HOME`, Sonnet 5.5 at
  medium effort:
  - `thread new --new-worktree --branch feat/x`; in its worktree `git switch -c feat/y`, a
    commit, pushed, merged `--no-ff` into main on origin. `thread checkouts` showed
    `feat/y (moved from feat/x)`.
  - `thread archive`: the archive cleanup logged "branch of a worktree a cleanup removes
    recorded ... last_head=feat/y" and removed it. `thread send ... --wait`: the worktree
    was back at `.../_local/proj/feat-x` on `feat/y` with `y.txt`, and the note said "...
    recreated from branch feat/y, where this thread had moved from feat/x."
  - Round two with `project worktree cleanup`: `git switch -c feat/z`, a commit, merged,
    plus an untracked file. The archive kept it ("uncommitted changes"), and
    `project worktree cleanup <id> --force --yes` removed it ("Removed 1 worktree: feat/z").
    The row then had `last_heads = {"<project>":"feat/z"}`. Daemon restarted, then a send:
    back on `feat/z` at the same path, the note named feat/z, `--resume` with the same
    session, and `last_heads` was empty after.
  - Daemon log: the only warnings were the namer's (1M-context usage credits), which
    are unrelated. Home, repos and transcripts were removed afterwards.
