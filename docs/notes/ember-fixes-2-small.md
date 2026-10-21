# Ember fixes 2: small daemon fixes (PR F, 2026-10-21)

The second Ember battle test (`ember-r2`) found six small daemon and skill problems:
e12-1, e12-3, e11-2/e10-10, e7-6, e10-8 and e3-10. This PR fixes them.

## Processes a thread leaves behind (e12-1)

**The finding.** A worker started a dev server with `(pnpm dev … &)`. The server outlived
the worker, its archive and its worktree's removal. It was re-parented to launchd, in
process group 7918, which is not Claude's group.

**What the brief assumed.** The brief said to put Claude in its own process group
(`Setpgid`) and to kill the negative pid on close. Claude was already in its own group:
`internal/childproc` sets `Setpgid` for both Claude and plugins. That fix alone would not
have caught the server. Measured with a real `claude -p` (Haiku 5.5): Claude Code starts
each Bash call in a new process group (detached spawn). A background process from a Bash
call ends up with:

- parent 1 (launchd);
- a group of its own, numbered after the Bash call's shell, which has exited.

Nothing in the process table still links it to Claude. macOS also hides other processes'
environments from non-root callers (`kern.procargs2` returns only argv), so tagging the
spawn with `CODE_FOUNDRY_THREAD` and matching on it does not work either.

**What was built.** Two layers.

1. **Claude's own group is the final step.** Once a Claude process has exited (after a
   graceful close or a crash), the runner signals what is left of its group (`killGroup`
   in `stream.go`, `childproc.Process.SignalGroup`). It sends SIGTERM first, then SIGKILL
   `streamKillGrace` (2 s) later, or at once on shutdown.
   - The graceful close is unchanged: interrupt, then stdin closed, then CloseTimeout,
     then SIGTERM, then SIGKILL (`beginClose`/`closeNext`).
   - The group kill happens only after the process is gone. It runs on every exit:
     close, archive, remove, idle stop, effort restart and crash.
2. **Strays in the worktree, on archive and remove** (`strays.go`,
   `internal/procscan`). Once Claude is gone and the thread's shells are removed, the
   store lists the user's processes (`sysctl kern.proc.uid`). It keeps the orphans
   (parent 1) that started after the thread was created. It reads their working
   directories with one `lsof -d cwd -p …` call and keeps those inside the thread's cwd.
   - **Only in a worktree Code Foundry made** (the cwd is strictly inside the daemon's
     worktree directory, `Options.WorktreeRoot`), each such process's **group** gets
     SIGTERM, then SIGKILL after `StrayGrace` (2 s) in the background, so the vite +
     esbuild pair goes together. The log line is `stopping processes the thread left
     running … processes="[sleep (42803)]" groups=[42801]`.
   - **In any other cwd, a project's own checkout above all, they are only logged** at
     Warn: "left running in the thread's checkout (not a worktree Code Foundry made, so
     not stopped)". Alex runs his own dev servers in his checkouts, and a lead started
     with `--new-worktree=false` lives there. Killing a user's server on archive is
     worse than leaving a stray one (coordinator's review of #297).

**Safety rules** (`strayDir`, `pickStrays`):

- Nothing is stopped outside the daemon's worktree directory, as above.
- Nothing is stopped when the cwd is the home directory or above it. This covers threads
  without a project.
- Nothing is stopped when another thread that is not archived works in the same
  directory, above it or below it, because its processes cannot be told apart.
- An app bundle (`.app/Contents/` in the executable path) is never stopped. Examples: an
  editor opened with `code .`, or a browser. These are logged at Warn as "left running".
- A live process's child is never stopped (its parent is not launchd). Neither is a
  process that started before the thread was created.
- So a lead started with `--new-worktree=false` (e3-10) gets its leftovers logged, not
  stopped. Its workers run in new worktrees, and theirs are stopped.

**Interrupt is not included.** The brief listed "interrupt/archive/remove". Interrupting a
turn keeps the process, and signalling Claude's group then would kill Claude itself.
Claude already kills the interrupted Bash call's group. Background shells
(`run_in_background`) are meant to keep running past an interrupt (`bgshells.go`).

**Cleanup logs leftovers.** `project.CleanupOptions.Removing` is told of each worktree
right before a real run removes it. The daemon (`logLeftovers`) logs any process still
running there at Warn ("processes still run in a worktree cleanup removes").

## Cleanup of an archived thread's fresh worktree (e12-3)

`project.CleanupOptions.Abandoned` lifts the `FreshFor` (10 minute) rule. The daemon's
`cleanupAbandoned` decides when a worktree counts as abandoned:

- No thread that is not archived is on it.
- At least one archived thread was on it, or one removed within `RemovedTTL`.
  `RemovedThread` gained `WorktreePath` for this.

A worktree that an orchestrator just made and no thread has used yet keeps the rule. The
reason given is `no commits since it was made; its threads are archived or removed`. Every
other rule still applies: uncommitted changes, unmanaged, commits not in the base, and the
hold.

## `thread report` cuts a long summary (e11-2, e10-10)

`CleanReport` no longer refuses a summary over 1000 characters. It cuts the summary to
999 characters plus "…", trimming any space before the ellipsis.
`ReportThreadResponse.summary_cut_from` (new, field 2) gives the original length. The CLI
says so: `reported done on thread … (the summary had 1200 characters and was cut to
1000; details belong in --data): …`. The full text is not moved into `--data`: data is
the agent's own JSON object, and the store does not write into it.

## `ember status` right after `ember reseed` (e7-6)

`epochContext` reports 0 while the reseed waits (`ReseedPending`) or the fresh session
has not started (`FreshStart`). After that, the row's `ContextTokens` is already the new
session's: the runner resets it when the old process goes. So the status shows 0 until
the new epoch's first turn. The thread row is left as it is: the old process's idle and
cache logic still reads its real size.

## A cut turn's partial usage (e10-8)

The projector keeps the running turn's usage per top-level response (message id):
`message_start`, the assistant frames and `message_delta` each report the same response,
and the projector keeps the largest value of each field. A turn the process ends before
its result (`cutTurn`: close, archive, daemon stop, crash, a restart mid-turn) gets the
sum of that usage and its model on the `process_ended` turn end. On every fixture the sum
equals the usage the result would have reported (`TestCutTurnUsage`).

`TurnCostUSD` stays unset. Pricing it would need the 5m/1h cache-write split and the
long-context tier, and the stream's `APIUsage` carries neither. The thread total (`usage
--thread`) was already right, because it comes from the transcripts. A turn the daemon
closes after it died (`closeLostRun`) still has zeros.

## Skill

`code-foundry-orchestrate/reference/leads.md` gained one rule: a lead that needs scratch
files writes them under `$TMPDIR` (each thread has its own), never in the skills
directory or the project checkout.

## Live check (scratch home, Haiku 5.5 medium)

All checks ran with `CODE_FOUNDRY_HOME=/tmp/ember-fix-f bin/code-foundry daemon --dev`
and a scratch repo with a bare origin under `~/ember-fix-f-scratch`. Both were deleted
afterwards.

1. **A background sleep dies with the archive.**
   - A thread in a new worktree ran `(sh -c 'exec sleep 600' > /dev/null 2>&1 &)`.
   - `ps` then showed pid 42803 with parent 1 and group 42801, which is not Claude's
     group. Its cwd was the thread's worktree.
   - `thread archive --yes` logged `stopping processes the thread left running …
     processes="[sleep (42803)]" groups=[42801]`, and the sleep was gone.
2. **Cleanup removes the archived thread's fresh worktree.** About a minute after the
   worktree was made, `project worktree cleanup app` listed
   `chore/bg-sleep-test …: no commits since it was made; its threads are archived or
   removed`. With `--yes` it removed the worktree, and the worktrees directory was empty
   afterwards.
3. **A long report is cut, not refused.** `thread report done "<1200 chars>"` exited 0
   with the message above. `thread get --json` showed a 1000-character summary ending in
   "…".

## Gotchas

- `TestRestartBusyInterrupts` flakes under `-race` on main as well: 3 of 150 runs failed
  on `origin/main`, and 0 of 150 on this branch. It failed once in this branch's first
  `make check`. The daemon end-to-end start timeouts (`TestConnectPrefersEndpoint`,
  `TestProjectServiceEndToEnd`) failed once under load and passed on rerun.
- `lsof` reports resolved paths (`/private/var/...`). `procscan.In` resolves its directory
  before comparing.
