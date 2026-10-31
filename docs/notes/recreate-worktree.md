# Recreate a cleaned-up worktree when its thread resumes

PR 2 of the agent CLI feedback 2 follow-ups. An orchestrating agent archives a finished
child and later runs `project.worktree.cleanup`, which removes merged worktrees the app
made and keeps their branches. A message to such a thread used to fail ("Claude did not
start: failed precondition: worktree ...: no such file or directory"). Now the daemon
makes the worktree again, at the same path, and resumes the conversation.

## Rules (agreed with Alex)

- **The branch is persisted.** Migration 0027 adds `threads.branch`, `Thread.Branch`
  and `codefoundry.v1.Thread.branch` (52; needed for `thread get --json`, the GUI does
  not read it). Set when Create makes the worktree (`newWorktree`, and `newWorkspace` for
  the cwd member) and copied by Fork, which now also copies `BaseRef` and
  `CreatedWorktree` (a fork runs in its parent's worktree, so it inherits what that
  worktree was made for). Meaning: "this thread was created for that branch"; if the
  agent switched branches inside the worktree, a recreation still uses the recorded one
  (since `docs/notes/recreate-last-head.md`: unless the cleanup recorded another HEAD).
- **Backfill.** Rows from before 0027 with `created_worktree` and no branch get it from
  the project store snapshot: `startBackfill` (thread store `New`) checks them every tick
  until their project has listed worktrees (its first reconcile after the daemon start;
  the snapshot is empty before), takes the branch of the worktree at the row's path, or
  leaves the row empty (worktree gone, detached, project gone). It gives up after
  2 minutes. Persisted, so it happens once per row.
- **When it applies** (`recreatable`): the cwd does not exist (`os.IsNotExist`, not any
  stat error), it is under the app's worktrees root (`project.InsideRoot`, new
  `thread.Options.WorktreeRoot`, the daemon passes `paths.Worktrees()`), the row has a
  branch and a project, and the thread is not a workspace's. Everything else keeps the
  old refusal from `resumeLaunch`.
- **Trigger.** Only a start of a stopped thread (`startStopped`): a send (which still
  unarchives), Reconnect, `running()` (MCP status refresh, reconnect). An effort restart
  restarts a live process, whose worktree a cleanup never removes (the cleanup hold
  skips worktrees with live threads), so it needs nothing. Fork of a thread whose
  worktree is gone still refuses (not in the brief).
- **How** (`recreateWorktree`): through `ProjectSource.CreateWorktree` with
  `Fetch: true`:
  1. the local branch exists: `git worktree add <path> <branch>`;
  2. else `refs/remotes/origin/<branch>` exists, or a targeted fetch finds it on origin
     (new `Options.FetchBranch`, default `git fetch --quiet --no-tags origin
     +refs/heads/<b>:refs/remotes/origin/<b>`, 30 s): git's DWIM tracking branch, no
     BaseRef (with a BaseRef the project store would branch from the base instead);
  3. else a new branch from the recorded `BaseRef`, or with none the project store's
     default base (origin/<default>, fetched).
  The project store picks the path from the project and branch, so the result must equal
  the recorded `WorktreePath` (`samePath`: cleaned or symlink-resolved); otherwise the
  start fails with "recreated the worktree of branch X at A, not at the thread's B; not
  resuming in another directory". A project that is no longer registered fails with
  "worktree ... is gone and cannot be recreated: its project ... is no longer
  registered". Refusals are the usual failed start: an error item, status error,
  `LastError`.
- **After.** A note item before the message: "The worktree was removed and has been
  recreated from branch X. Untracked and ignored files from before (build output,
  installed dependencies, local config) are gone." or, from the base, "... branch X no
  longer existed, so both were recreated from origin/main. Commits made on the branch
  earlier are on it only if they reached origin/main (a merged branch's have), and
  untracked and ignored files from before are gone." Once the spawn succeeded,
  `Options.WorktreeCreated` runs the on-worktree-create actions again, as after Create.
  A start without a message (Reconnect, `running`) still writes the note (it loads the
  log for it); it did not write the "transcript gone" note before and now writes it too
  when both apply.
- **Status.** The start is reserved (STARTING) as before; `ensureWorktree` publishes the
  thread before creating, so clients see STARTING (and busy, for a message) during the
  fetch rather than only after the launch is decided.

## Decided while building (not in the brief)

- The brief's "fetch first" became the targeted branch fetch in step 2 (a branch pushed
  to origin from elsewhere, never fetched here, is found) plus `Fetch: true` for the base.
  A stale remote-tracking ref of a branch deleted on origin still counts as "on origin":
  the branch comes back from that ref, earlier commits included.
- The base-path note says earlier commits are on the branch only if they reached the
  base, not "are not on it": the cleanup only removes merged worktrees, so in the usual
  case they are (the e2e's second run shows the merge commit on the recreated branch).
- A recorded explicit base that no longer exists is not replaced by the default: git's
  error is the failed start's reason.
- A worktree created at the wrong path is left in place (`ProjectSource` cannot remove);
  the next start then fails in git ("already checked out"), which is as clear.
- `thread get` prints `branch: <b>` after the worktree line when set; its description
  is unchanged (the guide's byte budget).

## Gotchas

- `samePath` already existed in `workspace.go`; reused.
- The test env's `restart` drops the per-test option mutators (`newWorktreeEnv`'s
  RefExists and project wrapper), so the recreation tests never restart; the backfill
  test uses the plain env.
- `code-foundry daemon stop` is not a verb: stop an e2e daemon with `kill`, and check with
  `pgrep` (and never edit its database while it runs: it holds rows in memory).
- `thread new` from inside the project folder without `--project` fails ("a worktree,
  project, or workspace is required"), and `--project <name>` answers "thread not found:
  project <name>"; the e2e used the project id. Not fixed here.

## End to end

`make build`; daemon in `CODE_FOUNDRY_HOME=/tmp/cf-rw-e2e/home`; a bare origin
`/tmp/cf-rw-e2e/origin.git` and its clone `~/cf-recreate-e2e-scratch` (removed after),
registered with `project add`; a background on-worktree-create action `Marker` appending
the date to `<worktree>.marker`. Haiku 5.5, medium effort.

```
$ code-foundry thread new --project 7428980528fa --new-worktree --model 'claude-haiku-5-5[1m]' --effort medium --prompt "create a file hello.txt with one line and commit it"
created thread s-cf98e0730d1a in /private/tmp/cf-rw-e2e/home/worktrees/_local/cf-recreate-e2e-scratch/cf-s-cf98e0730d1a (new worktree from origin/main)
$ code-foundry thread wait --id s-cf98e0730d1a --for 5m
thread s-cf98e0730d1a: needs attention (finished)
$ code-foundry thread get s-cf98e0730d1a
thread s-cf98e0730d1a
status: needs attention (finished)
worktree: /private/tmp/cf-rw-e2e/home/worktrees/_local/cf-recreate-e2e-scratch/cf-s-cf98e0730d1a
branch: cf/s-cf98e0730d1a
cost: $0.0030
$ git -C $W push origin cf/s-cf98e0730d1a       # then merged --no-ff into main in a second clone, pushed
$ code-foundry thread archive --id s-cf98e0730d1a --yes
archived thread s-cf98e0730d1a
$ code-foundry project worktree cleanup 7428980528fa --yes
Removed 1 worktree: cf/s-cf98e0730d1a
$ ls ~/.../_local/cf-recreate-e2e-scratch/
cf-s-cf98e0730d1a.marker

$ code-foundry thread send --id s-cf98e0730d1a "what did you do earlier in this thread?" --wait
thread s-cf98e0730d1a: needs attention (finished)
$ ls $W; git -C $W branch --show-current; git -C $W log --oneline -2
hello.txt  README.md
cf/s-cf98e0730d1a
a6b9f11 Add hello.txt
4ae85a9 init
$ cat $W.marker                                   # the action ran again
Sun Oct 18 03:01:52 CDT 2026
Sun Oct 18 03:02:07 CDT 2026
$ code-foundry thread read --id s-cf98e0730d1a --last 6
#5 turn end: success, 4.5s, 47640 in / 320 out tokens, $0.0030, $0.0030 so far, claude-haiku-5-5
#6 note: The worktree was removed and has been recreated from branch cf/s-cf98e0730d1a. Untracked and ignored files from before (build output, installed dependencies, lo…
#7 you: what did you do earlier in this thread?
#8 thinking
#9 claude: I made one change: I created `hello.txt` with the line `Hello, world!`, then staged and committed it as `a6b9f11` ("Add hello.txt") on `cf/s-cf98e0730d1a`. I ra…
#10 turn end: success, 2.1s, 25952 in / 207 out tokens, $0.0006, $0.0035 so far, claude-haiku-5-5
```

The daemon log: `worktree recreated for thread ... base=""`, then `thread spawned ...
--resume 43c0fb89-...` and the Marker run. `thread list --all` shows it unarchived.

The base path: archive, cleanup again, `git branch -D cf/s-cf98e0730d1a` in the project
and `git push origin --delete cf/s-cf98e0730d1a` (no local, remote or remote-tracking
ref left), then a send:

```
$ code-foundry thread send --id s-cf98e0730d1a "what did you do earlier in this thread?" --wait
thread s-cf98e0730d1a: needs attention (finished)
$ git -C $W branch --show-current; git -C $W log --oneline -2; git -C $W rev-parse --abbrev-ref @{u}
cf/s-cf98e0730d1a
5d8338c merge cf/s-cf98e0730d1a
a6b9f11 Add hello.txt
fatal: no upstream configured for branch 'cf/s-cf98e0730d1a'
$ code-foundry thread read --id s-cf98e0730d1a --role note --full
#17 note: The worktree was removed and branch cf/s-cf98e0730d1a no longer existed, so both were recreated from origin/main. Commits made on the branch earlier are on it only if they reached origin/main (a merged branch's have), and untracked and ignored files from before are gone.
$ code-foundry thread read --id s-cf98e0730d1a --last 4 --full     # excerpt
#20 claude: I created `hello.txt` containing `Hello, world!` and committed it as `a6b9f11` ("Add hello.txt"). I didn't change any other files.
$ code-foundry thread get s-cf98e0730d1a --json    # excerpt
{"branch": "cf/s-cf98e0730d1a", "baseRef": "origin/main", "createdWorktree": true, "archivedAt": null}
```

(The first base-path run, on the build before the note was reworded, wrote "Commits made
on the branch earlier are not on it" while the merge commit was right there: why the
wording changed.)

Backfill: daemon stopped, `update threads set branch=''` in its database, daemon
started: `branch of thread filled in from its worktree ... branch=cf/s-cf98e0730d1a` 1 s
later.
