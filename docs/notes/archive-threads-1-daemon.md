# Archived threads, PR 1 of 2: daemon, command, API mapping

Status: built on branch `t3code/archive-daemon`. `make check` green; exercised end to end
with an isolated daemon, the CLI and haiku threads (below). PR 2 (the sidebar's archived
section and the row menu's Archive / Unarchive) follows.

## Decisions (with Alex, not up for debate)

* Archiving is manual and reversible. It (a) ends Claude like `session.close` (the thread
  becomes DISCONNECTED "closed"), (b) kills and removes the thread's bottom-panel shells
  (`removeShells`, as Remove does), (c) unpins it, (d) stamps `archived_at`.
* Unarchiving only clears `archived_at`; the thread stays disconnected until a reconnect.
* Reconnect, Pin (pinned=true) and Send unarchive implicitly, so a thread the user works
  with again is back in the main list. Unpinning does not.

## What was built

* **Proto.** `Session.archived_at` (37, unset = not archived) and
  `SessionService.Archive(ArchiveSessionRequest{id, archived})` returning the session.
* **Store.** `Session.ArchivedAt`, migration `0017_session_archived.sql` (unix ms, 0 = not
  archived), `Store.Archive` in `internal/store/session/archive.go`:
  Close, then removeShells, then under `m.mu` unpin and stamp (the first stamp is kept on a
  re-archive). Like Remove, if a Reconnect won the race between the close and that step
  (the record has a runner or is not DISCONNECTED) Archive fails with FailedPrecondition
  instead of archiving a live thread; the archive flag is only ever committed on a
  disconnected thread. Reconnect clears it in the same update that prepares the spawn
  (persisted by spawn's commit, or by its revert); Pin(true) in its commit; Send after the
  message was accepted. `sessiontest.Fake` mirrors all of it.
* **API.** Thin `Archive` handler; `sessionToProto` maps `ArchivedAt` (the only place a
  store Session becomes a proto Session).
* **Command.** `session.archive` (`commands_session_archive.go`), Thread category, args
  `id` (context) and optional bool `archived` (default: the opposite of now). Result
  "archived thread <label>" / "unarchived thread <label>", JSON the session. The CLI verb
  (`code-foundry session archive`), palette entry and `--yes` come from the registry.
* **Frontend mapping only.** `SessionView.archivedAtMs: number | null`,
  `archiveSession(id, archived)` and `SESSION_COMMANDS.archive`. The mock daemon does not
  implement `session.archive` yet (PR 2 adds it with the UI); its sessions need no new field
  since the proto init type makes `archivedAt` optional.

## Confirmation only while Claude is mid-turn: `Command.ConfirmIf`

The registry asked for confirmation whenever `Confirm` was set; `DynamicConfirm`
returning "" meant "use the static message", and pr.merge, app.restart and
repo.worktree.cleanup rely on that fallback, so "" could not start meaning "no
confirmation". New field instead: `ConfirmIf(ctx, uctx, args) bool`; when set and false
the call runs without confirming. Listing still reports `requires_confirmation`, so the
CLI offers `--yes` and the GUI's runCommand handles the ConfirmationRequired error as for
any command (it never pre-asks from the listing flag).

`session.archive` asks only when archiving (never unarchiving) a thread that is STARTING,
or CONNECTED and busy ("Claude is still working") or waiting on a pending permission
request or question (status NEEDS_ATTENTION with reason `permission:` / `question:`,
"Claude is waiting on your answer"). Idle, finished, a failed turn (`error: ...`),
closing and disconnected threads archive at once. Message:
`Archive thread <name or id>? Claude is still working; archiving ends the turn.` (or
`... Claude is waiting on your answer; archiving ends the turn.`). An unknown id is not
asked about; Run reports NotFound.

## Gotchas

* Archive waits for the close like `session.close`: a thread whose Claude keeps a
  background Bash task alive ignores the closed stdin and is terminated after
  `CloseTimeout` (10 s), so the command can take that long.
* A thread archived while waiting on a permission prompt ends ERROR "interrupted" (the
  close interrupts the turn first), the same as closing it.
* Persisted at millisecond precision; the in-memory value until a restart has more.

## End to end (2026-10-13)

Isolated daemon `CODE_FOUNDRY_HOME=/tmp/cf-archive ./bin/code-foundry daemon --dev`, a
scratch repo `~/cf-scratch-archive` (`git init`, `repo.add`), haiku at effort low. Both
deleted afterwards.

```
$ code-foundry session.new --repo eb6484d6d657 --model haiku --effort low --name "archive check" --prompt "Run the shell command 'sleep 60' ..."
s-9e98095c3651
$ code-foundry terminal.new --context-session s-9e98095c3651
shell t-5a1f61104f0d {kind: shell, session: s-9e98095c3651, ...}
$ code-foundry session.pin --id s-9e98095c3651 --pinned=true
# Claude's foreground sleep was blocked; it backgrounded it and the turn finished, so:
$ code-foundry session.archive --id s-9e98095c3651 </dev/null
archived thread archive check (s-9e98095c3651)          # no confirmation: turn finished
{state: DISCONNECTED, status: NEEDS_ATTENTION finished, pinned: unset, archivedAt: 2026-10-13T09:43:20.897Z}
# daemon log: closing session; claude did not exit after stdin closed; terminating (10s);
#             removed the thread's shells count=1; archived thread
$ code-foundry terminal.list
ID  STATE  CWD  LABELS                                    # the shell is gone
$ code-foundry session.archive --id s-9e98095c3651
unarchived thread archive check (s-9e98095c3651)        # {DISCONNECTED closed, archivedAt: unset}
$ code-foundry session.archive --id s-9e98095c3651 --archived=true   # archivedAt 09:43:34.122Z
$ code-foundry session.archive --id s-9e98095c3651 --archived=true   # again: still 09:43:34.122Z
$ code-foundry session.reconnect --id s-9e98095c3651
reconnecting thread archive check (s-9e98095c3651)      # {CONNECTED, archivedAt: unset}

$ code-foundry thread.send --id s-9e98095c3651 --text 'Run ... for i in $(seq 1 45); do echo $i; sleep 1; done'
# {CONNECTED, BUSY working}; plus a new shell t-ca31490deac9 and a pin
$ code-foundry session.archive --id s-9e98095c3651 </dev/null
code-foundry session.archive: Archive thread archive check? Claude is still working; archiving ends the turn.
Re-run with --yes to confirm.                           # exit 2, nothing changed
$ code-foundry session.archive --id s-9e98095c3651 --yes
archived thread archive check (s-9e98095c3651)          # 0.2 s
{DISCONNECTED closed, ERROR interrupted, pinned: unset, archivedAt: 2026-10-13T09:43:51.631Z}
$ code-foundry terminal.list
ID  STATE  CWD  LABELS                                    # t-ca31490deac9 removed

$ code-foundry session.new ... --permission supervised --name "archive prompt check" --prompt "Create a file named hello.txt ..."
# {CONNECTED, NEEDS_ATTENTION "permission: Write hello.txt"}
$ code-foundry session.archive --id s-63b672a0ff53 </dev/null
code-foundry session.archive: Archive thread archive prompt check? Claude is waiting on your answer; archiving ends the turn.
Re-run with --yes to confirm.
$ code-foundry session.archive --id s-63b672a0ff53 --yes
archived thread archive prompt check (s-63b672a0ff53)   # {DISCONNECTED, ERROR interrupted, archivedAt set}
$ code-foundry session.pin --id s-63b672a0ff53 --pinned=true
pinned thread archive prompt check (s-63b672a0ff53)     # {pinned: true, archivedAt: unset}

# daemon stopped and auto-started again: archived_at survived
s-9e98095c3651 DISCONNECTED pinned=unset archivedAt=2026-10-13T09:43:51.631Z
s-63b672a0ff53 DISCONNECTED pinned=true  archivedAt=unset
```

Send unarchiving is covered by the store's table test (a live thread is never archived
through the API, so the CLI cannot reach that state).

## For PR 2 (the sidebar)

* Field `SessionView.archivedAtMs` (null = not archived); command `session.archive` with
  `archived=true|false`; `archiveSession(id, archived)` in `stores/sessionActions.ts`
  goes through runCommand, so the confirm dialog appears only when the daemon asks.
* Add `session.archive` to the mock daemon (`gui/frontend/mock/world.ts`) and an
  `archivedAt` on its sessions.
