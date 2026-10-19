# Orchestration: the child's side (2026-10-19)

Three daemon changes from the 2026-10-19 orchestration battle test (report items A4, A7,
A12; evidence e4 §4.1 and §4.8, e3 item 2, w2 finding 3, w4). They change what a child
thread's Claude sees and gets; the wake engine and the skill text are other PRs.

## What shipped

| Part | Where |
|---|---|
| **Resume note (A4).** The budget stop, another thread's `thread interrupt` of a running turn, and the daemon stopping (or dying) mid-turn leave a pending note on the thread. The next user message Claude gets, whatever its origin (the user, an orchestrator's send, a wake), starts with one line, then a blank line, then the text | `internal/store/thread/resumenote.go`, `budget.go` (`crossBudget`), `conversation.go` (`Send`, `Interrupt`), `stream.go` (`sendMessage` clears, `shutdown` sets), `manager.go` (`New` sets for rows that died mid-turn) |
| The note is persisted (`threads.resume_note`, JSON, migration 0036), kept on the message's item (`Item.ResumeNote`, `UserMessageItem.resume_note`), and cleared once the message went out | `db.go`, `items_db.go`, `internal/db/migrations/0036_thread_resume_note.sql`, `proto/codefoundry/v1/thread.proto` |
| `InterruptThreadRequest.by_thread_id`; `thread interrupt` sends it as `--by`, which the CLI fills from `$CODE_FOUNDRY_THREAD` | `internal/command/commands_thread.go`, `internal/api/thread.go`, `Store.Interrupt(ctx, id, by)` |
| GUI: a message that carried a note shows one muted lineage-note line above it, "Told Claude <note without its prefix>" (tooltip when truncated) | `gui/frontend/src/api/thread.ts`, `components/thread/rows.tsx` (`ResumeNoteRow`) |
| **Protocol verbs pre-allowed (A7).** Every spawn gets `--allowedTools` for `code-foundry thread report`, `thread reports`, `thread get`, `thread list`, `thread read` and `project list` (`Bash(<verb>:*)`), before an effort restart's own grants | `internal/store/thread/childcontext.go` (`ProtocolAllowedTools`), `manager.go` (`claudeCommand`); the `--permission` help says so |
| **Per-thread TMPDIR (A12).** Each thread's claude gets `TMPDIR=<home>/tmp/<thread id>`, made at every spawn, removed by `thread remove`, and the directories of threads that no longer exist are removed at daemon start | `childcontext.go`, `manager.go` (`Options.TmpRoot`, `Remove`, `New`), `internal/paths` (`Tmp`), `internal/daemon/stores.go` |

The lines Claude gets:

```
[code-foundry] Your previous turn was stopped by Code Foundry at its $0.50 spending limit (now $1.00), not rejected by anyone; your last tool call may have run partially, so check its effects before repeating it.
[code-foundry] Your previous turn was interrupted by thread "Lead" (s-1a2b3c4d5e6f) through Code Foundry, not rejected by anyone; ...
[code-foundry] Your previous turn was stopped because the Code Foundry app restarted, not rejected by anyone; ...
```

"(now $X)" appears when the budget changed since the stop, "(now no limit)" when it was
removed; nothing when unchanged.

## Decisions

* **Who gets no note.** The user's own interrupt (the GUI's button, the CLI outside a
  thread): "interrupted by user" is the truth then. A thread interrupting itself. An
  interrupt of a thread that was not mid-turn (busy, or asking within a turn; the
  published status decides). A daemon stop while the thread sat at its prompt.
* **The latest stop wins.** A newer cause replaces a pending note (a budget stop, then a
  turn Claude starts by itself that the app restart cuts off: the restart note).
* **Cleared on delivery, not on Send.** `Send` reads the note and puts it on the
  message and its item; `sendMessage` clears it once Claude Code accepted the message
  (a start that fails keeps it for the next try). The clear compares cause and time, so
  a stop that landed in between is not erased. Two concurrent sends both carry it: rare
  and harmless.
* **`--by`, not the context thread.** An explicit `--id` stands in for the context
  thread when commands run (`Invoke`), so `thread interrupt --id X` from inside thread Y
  had context thread X. `by` is its own arg with `DefaultToThreadEnv`; the guide hides it
  (a new "(the CLI sets it" rule beside "(the GUI sets it)"), since no agent passes it.
* **Allow rules on every spawn, not only supervised ones.** `SetPermissionMode` switches
  a live process to supervised without a respawn, so the rules must be there already.
  In auto and accept-edits they only skip the classifier for these read-only verbs.
  Plain `--allowedTools`: no hooks and no `--strict-mcp-config`, which the work
  laptop's managed settings forbid. A managed `allowManagedPermissionRulesOnly` would
  ignore them, and the thread then asks as before: nothing breaks.
* **The list is read-only verbs plus `report`.** `send`, `respond`, `interrupt`,
  `budget`, `remove`, worktree removal and the like still ask in supervised mode.
* **TMPDIR goes before the workspace's and the thread's own env** (a plugin-owned
  thread's `SpawnEnv` may set its own); plugins cannot set it (a reserved name). The
  daemon creates the directory with 0700 on every spawn (cheap, idempotent), so a thread
  whose directory was removed by hand gets it back.

## Gotchas

* **A variable expansion still asks.** In supervised mode `code-foundry thread get --id
  $CODE_FOUNDRY_THREAD` asked for permission (Claude Code does not match rules through
  `$VAR`); `code-foundry thread get` (the default id is the thread itself) ran unasked.
  Children should use the defaults; the skill text may want a line.
* **Claude Code's own scratch files do not follow TMPDIR.** Background Bash output still
  goes to `/private/tmp/claude-<uid>/…/tasks/` (seen live). Nothing in the daemon reads
  it (`claudestream.Task.OutputFile` is parsed, never opened), and nothing else in the
  daemon relied on the thread process's inherited TMPDIR. The namer runs in `/tmp` and
  keeps the daemon's.
* **`thread read`'s text output shows the message only** (`you: continue`); the note is
  in `--json` (`userMessage.resumeNote`) and in the GUI. Left for the CLI PR in flight.
* **Guide cap.** The `--permission` help grew; "Permissions: " was dropped from it to
  stay under 29,000 bytes (28,997).
* **Migration number.** 0036 may collide with another PR in flight; the one that merges
  second renumbers.

## Verified

* `make check` green; table tests for the note text per cause, the column round trip,
  `midTurn`, the allow list, the TMPDIR path; store tests for the budget note across a
  store reopen (prefix sent, item keeps it, cleared and saved), the interrupt note (by
  another thread; none for the user, itself or an idle thread), the restart note (a
  clean stop mid-turn and a row that died busy), the spawn's argv/env and the TMPDIR's
  removal and reaping; a command test for `--by`; a GUI row test.
* Live, isolated daemon (`/tmp/cf-build-orch-child-context`), Haiku 5.5 medium children
  in a scratch todo project:
  * Budget: a child with `--budget 0.004` was stopped after four reads; the note was in
    the DB, survived a daemon restart; `thread budget 0.10` then `thread send continue`.
    Claude's transcript has `[code-foundry] Your previous turn was stopped by Code
    Foundry at its $0.004 spending limit (now $0.10), not rejected by anyone; …\n\ncontinue`,
    and it carried on with the remaining steps with no rejection behaviour. Note cleared.
  * Interrupt: `CODE_FOUNDRY_THREAD=<other> code-foundry thread interrupt --id <child>`
    during a 30 s foreground command; Claude Code told it "The user doesn't want to
    proceed… STOP"; on the next "go on" (with the note naming the other thread) it ran
    `git status` and checked NOTES.md before repeating the command.
  * Restart: the daemon was stopped (SIGTERM) during a 30 s command; after the restart,
    "go on" got the restart note and Claude said the call had been killed (exit 137),
    checked that nothing was applied, and ran it again.
  * Supervised: a supervised child ran `thread get`, `thread reports`, `thread read`,
    `thread list`, `project list` and `thread report done …` without a permission
    prompt (only `--id $CODE_FOUNDRY_THREAD` asked, above).
  * TMPDIR: a child's `echo "$TMPDIR"` printed
    `/tmp/cf-build-orch-child-context/tmp/s-295beb8436b7`; `go build`/`go test` ran
    with it.
