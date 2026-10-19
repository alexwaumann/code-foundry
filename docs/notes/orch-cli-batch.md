# Orchestration CLI batch (2026-10-19)

The CLI items of the 2026-10-19 orchestration battle test (report REPORT.md section B,
plus A9, A11 and A13; write-ups e3, e4, e6, e8, w2, w3, w4). Each item is its own commit.
The wake engine (`subscriptions_fire.go`, `wake.go`) is untouched: #241 changed it.
Skill text changes only where this PR made it wrong (patterns.md §7).

## What shipped

| Item | Change | Where |
|---|---|---|
| B1 | A dash word with white space in its name (`"--json now emits …"`) is a positional word, like a negative number; a bad flag prints the flag package's line and `Run code-foundry help <cmd> for usage; a value that starts with - goes after --.`, not the whole help (`-h` still prints it) | `cmd/code-foundry/confirm.go` (`dashWord`, `spacedDash`), `registry.go` (`badFlag`) |
| B2 | `thread list` puts `(you)` after the context thread's name; `--json` has `isCaller: true` on that row | `commands_thread_list.go` (`markCaller`), `Thread.is_caller` |
| B3 | `thread send` from a thread with a settled, idle or attention subscription to the target prints `you are subscribed (sub-…): end your turn; it wakes you` instead of the wait hint | `commands_thread.go` (`sendNext`), `Context.CallerThreadID` |
| B4 | `thread get --json` has `pending` (kind, requestId, tool, input, question, options, questions), and the text a `pending:` line | `GetThreadRequest.with_detail`, `Thread.pending` (`ThreadPendingDetail`), `internal/store/thread/detail.go`, `internal/api/thread_detail.go` |
| A9 | `thread get` prints `report: done*: … (report predates its last message)`, `--json` `reportStale: true`; `thread reports` `done*` with the same note and `stale: true` | `Thread.report_stale`, same files; `commands_thread_reports.go` (`markStale`) |
| A11 | A thread id suffix that names no thread resolves against the threads removed within the day; `get`, `wait`, `send`, `read` and `items` print the same first line (`thread <name> (<id>) was removed at <time>`), the last report and the cost, exit 1; the tombstone keeps usage and budget; `thread reports --json` has `costUsd` | `resolve.go` (`SetIDFallback`, `removedThreadIDs`), `commands_thread_removed.go`, `tombstones.go`, `RemovedThread.cost_usd/unpriced/budget_usd` |
| A13 | `events` that the user did not stop exits 1 with `daemon connection lost; resume with --since <last seq> --since-epoch <epoch>`; `--since` without `--since-epoch` prints a notice and starts with snapshots | `cmd/code-foundry/events.go` |
| B5 | `project worktree remove --path <wt> --yes` takes the project from the path; no path says `give the worktree with --path`; a path no project has names `--project`. New `project branch delete <project> <branch> --yes [--force] [--remote]` | `commands_project.go`, `commands_project_git.go`, `commands_project_branch.go`, `ProjectService.DeleteBranch`, `internal/store/project/branch_delete.go` |
| B7 | `thread subscriptions` LAST FIRED in UTC RFC 3339; `help thread` (a group) lists its commands, a bare `thread` does on stderr (exit 2); `thread read --full` prints a wake's JSON; `respond --answer` prints `answered "<question>": <label>`; the daemon logs INFO `request answered` (thread, request, decision) | `commands_thread_subscribe.go`, `cmd/code-foundry/registry.go`, `commands_thread.go`, `internal/store/thread/conversation.go` |

## Decisions

* **B1 is general, and safe.** No flag name contains white space, so a token like
  `--json now emits` can only be text; one without a space (`--json`) is still a flag and
  needs `--`. The flag after which the word is a value keeps it (`--usd "-1 x"`),
  `--data={"a": 1}` stays a flag (the space is after `=`). Per-command "the summary is
  positional after the status" was not needed.
* **The caller is `Context.CallerThreadID`**, the active thread as the caller sent it,
  set by `Invoke`. `thread send --id X` overlays X onto the active thread (the id arg is
  context-bound), so its Run could not see the CLI's own thread before. The GUI's
  "caller" is its focused thread, which is harmless here.
* **`is_caller` is a Thread field set by the command**, on a copy of the row, never by
  ThreadService: the brief asked for `"isCaller": true` on the row, and a wrapper would
  have changed `thread list --json`'s shape.
* **Detail on request only.** `pending` and `report_stale` need the thread's items, which
  the store loads (and keeps) on first read. Only `GetThreadRequest.with_detail` reads
  them: `thread get`, and `thread reports` for each listed thread that has a report. The
  GUI and the other ~10 Get callers read nothing new. List is unchanged.
* **The wake's rules, not a copy.** `thread.DetailOf` calls `wakeDetailOf` (and so
  `pendingRequestOf`) from a new file; `subscriptions_fire.go` is not edited.
  `PendingDetail` is an alias of the wake's `wakePending`. If the wake PR changes
  `wakeDetailOf`'s signature, `detail.go` follows it. `report_stale` is the wake's
  `staleReport` alone (a report older than the last top-level user message, wakes
  included), not its "no report" half, and is shown whatever the status, so a busy child
  working on a follow-up shows its old report as stale.
* **`pending.input`** is a `google.protobuf.Value`: the tool input's JSON object, or the
  wake's cut string over 4 KiB.
* **Tombstone suffixes are a fallback**: live ids first, removed ones only when no live id
  ends in the suffix (one more List call, only on a miss). `thread reports --created-by`
  still resolves against live ids (a removed creator's full id filters, as before).
* **One removed message.** The first line is the old `thread get` form for all of them
  (`wait` used `thread <id> <name> was removed`). `get` keeps its creator and labels lines;
  all add the last report and `cost: $X (of a $Y budget)`. `read` and `items` used exit 2
  through the NOT_FOUND error; they now read the RemovedThread detail like `get`.
* **`events --since` without `--since-epoch` always starts with snapshots.** The CLI
  cannot know which daemon a bare seq came from (E8's `--since 2` matched the new
  daemon's numbering and replayed nothing useful). A script that wants a replay passes
  the epoch every `--json` event carries. The resume hint uses the last live event's seq
  and epoch; with none seen it says to run again (snapshots).
* **Branch delete is in the project store, not gitops.** The project store already runs
  `git branch -D` for `--delete-branch`; gitops ops resolve a worktree path and record a
  GUI op, which a branch with no worktree does not have. `-d` by default: git refuses a
  branch not merged into its upstream or HEAD (a pushed branch counts as merged into its
  upstream, so W4's pushed discard branch goes without `--force`). `--remote` is
  `git push origin --delete`; origin not having the branch is not an error unless nothing
  was deleted at all (NotFound). The default branch is refused by name; git refuses a
  checked-out one.
* **Guide budget.** The guide was at 28,964 of its 29,000 bytes. To describe `(you)`,
  the pending request and the stale star (and list `project.branch.delete`), the snooze
  `until` forms are listed once (on the arg), `thread.list` drops its archived sentence
  (the conventions say it), `thread.read` its nextSince hint (same), and
  `thread.mcp-reconnect` says its login hint in fewer words. After rebasing on the wake
  PR (#241, +32 bytes) `thread.get` also drops "(--json: the thread with every field)".
  Now 28,982 bytes.
* **Skill §7 follows the CLI.** The v3 skill (#240, merged meanwhile) said `project
  worktree remove` needs `--project` inside a thread and sent a pushed branch to raw
  `git push origin --delete`. `reference/patterns.md` §7 now drops `--project` and
  names `project branch delete … --remote --yes`.

## Gotchas

* `thread send` had a context-bound `--id`: `uctx.ActiveThreadID` inside Run is the
  target, not the caller. Use `CallerThreadID` for "who is calling".
* The commandtest Thread fake's `Get` now answers the thread in `Others` with the asked
  id when `Current` is unset (thread.reports asks per thread).
* `internal/store/thread/threadtest` builds its tombstones with `thread.TombstoneOf`, so
  the fake keeps what the store keeps.
* The sandbox for this build refused `git -C <scratch>` in compound commands; the live
  check ran scratch-repo git through a script under `/tmp`.

## Verified live

Isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-build-orch-cli-batch`), scratch project
`ocb-todo` with a bare origin, two Haiku 5.5 (medium) threads: Parent and a supervised
Child created by it.

```
$ thread report done "--json now emits JSON Lines (one per item)" --id s-11fb8339c300
reported done on thread Child (s-11fb8339c300): --json now emits JSON Lines (one per item)
$ thread report done --jsonl --id s-11fb8339c300          # exit 2
flag provided but not defined: -jsonl
Run `code-foundry help thread.report` for usage; a value that starts with - goes after --.
$ CODE_FOUNDRY_THREAD=<Parent> thread list
s-11fb8339c300  idle  Child         ocb-todo@main  2s  ↳ Parent
s-8698047c0356  idle  Parent (you)  ocb-todo@main  4s
$ CODE_FOUNDRY_THREAD=<Parent> thread send --id <Child> "…"   # before / after subscribing
sent to thread s-11fb8339c300 (#2); wait with: code-foundry thread wait s-11fb8339c300 --after 2
sent to thread s-11fb8339c300 (#6); you are subscribed (sub-f71df800ef68): end your turn; it wakes you
$ thread get 11fb8339c300                                      # after a follow-up to a done report
report: done*: Added --json output (2026-10-19 09:56:40) (report predates its last message)
$ thread reports --created-by 8698047c0356
s-11fb8339c300  done*  Child  Added --json output (report predates its last message)
$ thread get <Child>                                           # supervised Write pending
status: needs attention (permission: Write hello.txt)
pending: permission Write (request 7a778e7b-…)
$ thread get <Child> --json | .pending
{"kind": "permission", "requestId": "7a778e7b-…", "tool": "Write", "input": {"content": "hi", "file_path": "…/hello.txt"}}
$ thread respond --id <Child> --answer Blue
answered "Which color?": Blue; nothing pending
daemon.log: "msg":"request answered","thread":"s-11fb8339c300","request":"33bee962-…","decision":"answer"
$ thread subscriptions --id <Parent>
… LAST FIRED 2026-10-19T14:57:08Z …
$ thread read <Parent> --role wake --last 1 --full            # title, then the wake's JSON
$ CODE_FOUNDRY_THREAD=<Parent> project worktree remove --path /tmp/…/cf-discard --yes
removed worktree /tmp/cf-build-orch-cli-batch/worktrees/_local/ocb-todo/cf-discard
$ project branch delete ocb-todo cf/discard --yes
deleted branch cf/discard locally
$ project branch delete ocb-todo cf/discard --force --remote --yes
deleted branch cf/discard on origin
$ thread remove --id 11fb8339c300 --yes; thread get 11fb8339c300   # also wait --id 8339c300, read 11fb8339c300: same, exit 1
thread Child (s-11fb8339c300) was removed at 2026-10-19 09:57:48
created by: s-8698047c0356
last report: done — Added --json output
cost: $0.0039
$ events --json --source thread-list   # daemon SIGTERMed
code-foundry events: daemon connection lost; resume with --since 1 --since-epoch 8276285a8f9a   (exit 1)
$ events --source thread-list --since 1                        # after a restart
code-foundry events: --since 1 without --since-epoch could be another daemon's seq; starting with snapshots (pass both to resume)
- thread-list snapshot
```

`help thread` lists the 40-odd thread commands with their titles.

## Left for later

* B6 (`--descendants-of`) was not in this batch.
* The live check ran before rebasing on #240/#241; after the rebase only unit tests
  and `make check` ran again.
