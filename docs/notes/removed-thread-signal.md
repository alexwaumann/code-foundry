# Removed threads: a signal and a tombstone

The orchestration experiment of 2026-10-18 (REPORT.md B2 and C9; e4 findings F1-F3)
found that removing a child thread looked like anything but a removal to the agent that
created it. Its blocking `thread wait` returned exit 0 `idle (at prompt)` (the CLOSING
snapshot), its `--notify` wake read `is idle: at prompt.`, and afterwards `thread get` and
`thread wait` gave exit 2 "not found", like a typo. The thread vanished from `list --all`
and `reports`, and the daemon logged nothing about the removal itself. The orchestrator
blamed the archive step and "records that seem to disappear".

## What changed

* **Removing.** `Store.Remove` sets `Thread.Removing` (not persisted, not on the API)
  before it closes the thread. `Meets` is false for such a thread, so neither
  `ThreadService.Wait` nor a wake subscription takes the closing snapshot for a settled
  thread. `observeLocked` skips it and keeps each subscription's last `sat`, so a removal
  that fails (and clears the flag) compares the next change with the state from before.
* **Tombstones** (`internal/store/thread/tombstones.go`). Remove keeps
  `{id, name, project, workspace, created_by, owner, labels, last report, removed_at}` in
  memory for 24 h (`RemovedTTL`, like the request ids). It adds the tombstone before it
  publishes `Removed`, so a waiter that sees the event finds it. A look-up of the id
  (`Get`, and everything through `record`: Send, Label, ...) is a `*RemovedError`, which
  `errors.Is` ErrNotFound. The API maps it to NOT_FOUND with a `RemovedThread` detail.
  The daemon logs INFO `thread removed` with `thread`, `name` and `created_by`.
* **Removed wake** (`subscriptions_removed.go`). Once the thread is forgotten, each thread
  subscribed to it gets one wake, whatever its conditions:
  `Thread "X" (id) was removed.`, with JSON `condition: "removed"`, `removed_at`, and the
  last report. Then `forgetLocked` deletes the subscriptions as before. Archive is
  unchanged.
* **API** (`proto/codefoundry/v1/thread_lifecycle.proto`). `RemovedThread` message;
  `WaitThreadResponse.removed`, set when the thread was removed before or during the wait
  (`thread` unset); `ThreadFilter.include_removed` adds `ListThreadsResponse.removed`.
  `created_by`, labels, project, workspace and owner apply to removed threads. A status or
  state filter leaves them all out. The limit applies to them separately.
* **CLI.** `thread wait` and `thread send` (with or without `--wait`) on a removed thread
  print `thread <id> <name> was removed at <time>` and the last report, then exit 1.
  `--json` gives a `ThreadReport` with `status: "removed"`, `removed: true` and
  `removedAt`. `thread get` prints `thread <name> (<id>) was removed at <time>`, the
  creator, the labels and the last report, and exits 1. `thread reports --all` lists
  removed threads after the others: the status column reads `removed` and the summary
  `last report done: …` or `no report`. `--archived` alone still leaves them out, and the
  empty message says so. `thread list --all` adds them, aligned with the other threads:
  `-` for status and place, age since removal, `[removed]`, and the creator.

## Decisions

* **A response field for Wait, an error detail for Get.** Wait has two callers
  (`thread.wait` and `send --wait`), and both want the tombstone as an answer. Get has
  about ten callers in `internal/command`, which should keep failing on a removed id, so
  it stays NOT_FOUND and only `thread.get` reads the detail. Every RPC that looks the
  thread up through the store gets the detail for free (`threadError`).
* **Exit 1, not 2.** Exit 2 means "you called it wrong". A removed thread is a fact about
  the world, like a timeout (also exit 1). The result is printed on stdout, with the
  JSON, as for `action.run --wait`'s exit code. It is not an error on stderr.
* **One removed wake per subscriber**, under its oldest subscription, even when it held
  several conditions on the target. It goes through `fireLocked`, so the wake limit
  applies. The daemon's `wake subscription fired` line still names the subscription's own
  condition. The `woke thread` line has the removed title.
* **In memory only.** A daemon restart forgets tombstones (shown in the transcript), and
  `thread get` is then exit 2 "not found" again. Persisting them would need a migration
  for a 24 h convenience; the request ids' table is different because a retried create
  must not double-spawn across a restart.
* **Suffix resolution** of ids (`ResolveID`) does not know tombstones. Agents use full
  ids, which pass through to the daemon unresolved.
* The GUI is unaffected. The wake row renders `wakeTitle`, and nothing reads the new
  fields.

## Gotchas

* The agent guide (`internal/guide`, built from the command descriptions) was at 28,996
  of its 29,000-byte cap. So the help only changes in two places: `thread.wait` "Exits 1
  on timeout or removal." and `thread.reports --all` "Archived and removed too". The
  guide is now at 28,999. The next help text that grows has to cut something first.
* `defer m.mu.Unlock()` and the deferred `setRemoving(false)` in `Remove`: the defers run
  LIFO, so the unlock comes first and `setRemoving` can take the lock.
* Claude Code blocks a standalone `sleep 120` in Bash ("use Monitor"). The first
  end-to-end child finished at once because of it. A `ping -c 120 127.0.0.1` kept the
  second child busy.

## End to end (Haiku 5.5, medium; isolated daemon `/tmp/rts-home`, project `rts-todo`)

The parent was told to run `thread new --notify` for a child whose task was a 120 s
ping, then `thread wait <child> --for 5m; echo "exit=$?"`. The child was removed from
outside while it pinged, at 01:03:43. Two outside waits (text and `--json`) were also
blocked on it.

The parent's blocking wait (its Bash tool result):

```
thread s-ce3cb99cf64e Slow child 2 was removed at 2026-10-19 01:03:43
last report: progress — sleeping 120s
exit=1
```

The outside waits:

```
thread s-ce3cb99cf64e Slow child 2 was removed at 2026-10-19 01:03:43
last report: progress — sleeping 120s
exit=1
{"id":"s-ce3cb99cf64e","name":"Slow child 2","status":"removed","reportStatus":"progress","reportSummary":"sleeping 120s","reportAt":"2026-10-19T06:03:30.916Z","createdBy":"s-4d852c9b89ea","labels":[],"removed":true,"removedAt":"2026-10-19T06:03:43.966Z"}
exit=1
```

The parent's only wake (none for the closing snapshot):

```
[code-foundry wake] Thread "Slow child 2" (s-ce3cb99cf64e) was removed.
{ "kind": "thread", "subscription_id": "sub-cf0353cf8db5", "condition": "removed",
  "fired_at": "2026-10-19T06:03:43.966Z",
  "thread": { "id": "s-ce3cb99cf64e", "name": "Slow child 2", "project_id": "e5a6fdbf12d1",
    "created_by": "s-4d852c9b89ea", "labels": [], "removed_at": "2026-10-19T06:03:43.966Z",
    "report": { "status": "progress", "summary": "sleeping 120s", "data": null, "at": "2026-10-19T06:03:30.916Z" } } }
```

Then Haiku replied with that first line, as told.

After the removal:

```
$ thread get s-ce3cb99cf64e
thread Slow child 2 (s-ce3cb99cf64e) was removed at 2026-10-19 01:03:43
created by: s-4d852c9b89ea
last report: progress — sleeping 120s
exit=1
$ thread send --id s-ce3cb99cf64e --wait hi
thread s-ce3cb99cf64e Slow child 2 was removed at 2026-10-19 01:03:43
last report: progress — sleeping 120s
exit=1
$ thread get s-000000000000
code-foundry thread.get: thread not found: s-000000000000
exit=2
$ thread reports --created-by s-4d852c9b89ea
no threads (archived threads are left out; --archived includes them)
$ thread reports --created-by s-4d852c9b89ea --all
s-ce3cb99cf64e  removed  Slow child 2  last report progress: sleeping 120s
```

The daemon log:

```
INFO closing thread thread=s-ce3cb99cf64e
INFO thread removed thread=s-ce3cb99cf64e name="Slow child 2" created_by=s-4d852c9b89ea
INFO wake subscription fired subscription=sub-cf0353cf8db5 subscriber=s-4d852c9b89ea target=s-ce3cb99cf64e condition=settled fired_count=1
INFO wake subscriptions deleted with their thread thread=s-ce3cb99cf64e why=removed
INFO woke thread thread=s-4d852c9b89ea wake="Thread \"Slow child 2\" (s-ce3cb99cf64e) was removed."
```

After a daemon restart (rebuilt with the aligned list), the first tombstone was gone
(`thread get s-ce3cb99cf64e`: exit 2 "not found"). The first, idle child of the earlier
run was then removed:

```
$ thread list --all
s-81c51c2b2d6a  busy                  Parent      rts-todo@main  now
s-4d852c9b89ea  attention (finished)  Parent 2    rts-todo@main  2m
s-0fc640a070b5  -                     Slow child  -              now  [removed]  ↳ Parent
```

Its parent is busy because the removed wake woke it.
