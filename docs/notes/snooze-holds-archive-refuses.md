# A snooze holds, an archive refuses

A snooze and an archive are the user's decisions. Another thread could undo both: any
`thread send` unsnoozed and unarchived its target (Send's `backToList`), and a thread's
CLI could unarchive, pin or unsnooze any thread. Now only the user (or, for an archive,
the thread's creator) undoes them. Code: `internal/store/thread/holds.go`.

This corrects `archive-threads-1-daemon.md` ("Reconnect, Pin and Send unarchive
implicitly"), `snooze-threads-1-daemon.md` ("Reconnect, Pin(true) and Send unsnooze") and
`agents-4-wake.md` ("a snoozed one is unsnoozed (Send's backToList)"): those hold for the
user only.

## What was agreed

* **A snooze holds.** A message from another thread, or a wake (thread, PR, action,
  plugin, timer), does not end a snooze: the thread starts if needed, works and stays
  snoozed with its time unchanged. If it asks the user (a permission, a question) it is
  under Needs you with the snooze held underneath; answering is not the user picking it
  back up, so once it stops asking it is in Snoozed again with the same time. Only the user
  ends a snooze: their own message, Dismiss (`thread snooze --clear`), or the time
  arriving. A snoozed thread stays addressable.
* **An archive refuses.** A thread cannot message, unarchive, pin, snooze, save for later
  or retry the setup of an archived thread it did not create (each of those unarchives):
  FailedPrecondition, "thread X is archived, and a thread cannot message an archived
  thread it did not create: only the user can unarchive it. Read it instead (code-foundry
  thread read X), or, if it is needed, tell the user". A wake to an archived thread is
  refused too (its subscriptions went with the archive, so only a race gets there).
  Reading is untouched. Wake subscriptions on archived threads stay refused.
* **A thread's own workers are exempt.** A lead may send to the archived threads it
  created, which unarchives them, as before.

## Decisions made here

* **"Created" is the creator chain**, not the direct creator only (`createdByLocked`: the
  thread's `CreatedBy`, its `CreatedBy`, and so on, at most `MaxLineageDepth`+1 levels).
  Archiving a thread takes every thread below it along (`ArchiveCascade` walks the same
  chain), so a lead that archived its worker also archived the worker's workers; the
  direct-only rule would leave the lead unable to bring back threads its own archive put
  away. A removed thread ends the chain, as the sidebar rule has it (its threads are the
  user's once it is gone). A thread is never its own creator, and a thread it created is
  not its creator (a worker cannot unarchive its lead).
* **Who is calling.** A message carries `Message.ByThreadID` (the CLI's
  `$CODE_FOUNDRY_THREAD`); every other verb carries the asking thread in the context
  (`thread.AskedBy`, renamed from `ArchivedBy`, which archives already used for group
  wakes) from the request's `by_thread_id`, which the command layer fills with
  `askingThread(c)`: the CLI's context thread when no window view is set, never the GUI.
  `PinThreadRequest` and `RetryThreadSetupRequest` got a `by_thread_id`. A compact names
  the thread itself only to stay out of the prompt history: it counts as the user's.
  `thread send --by=` (an explicit empty sender) from a thread's CLI now still sends as
  that thread (`cmp.Or(by, askingThread)`), since what it may do hangs on it.
* **Explicit snooze-ending verbs follow the archive's rule.** A thread may dismiss a
  snooze (`thread snooze --clear`) or pin a snoozed thread (pinning unsnoozes) only when it
  created it; a message never ends a snooze, whoever sends it (a lead's message to its own
  snoozed worker holds the snooze too: only the user ends one). Re-snoozing to another
  time and archiving stay allowed: neither undoes a put-away (archiving a snoozed thread
  replaces the snooze with the stronger put-away, as before).
* **A page in a thread is that thread.** A page's calls have the CLI context of its thread
  (`Context.FromUser` already treats them so), so a page's Unarchive button works only on
  threads its thread created. The safe reading: page code can call verbs without a click.
* **Plugins are unchanged.** A plugin's `SendThread` to its own threads has no thread
  sender, so it brings them back as before.
* **The snooze time arriving while the thread works** ends the snooze as before:
  `wakeSnoozed` clears it and leaves the live thread's status alone (no "snooze ended":
  it is working). Tested (`TestSnoozeEndsWhileWorking`).

## What else had to change for a snoozed thread that works

* **Action runs** (`internal/daemon/actions.go`): the cleanup killed a thread's background
  runs on every `Updated` that read snoozed, which would now kill the runs a working
  snoozed thread starts. It kills on the moment a thread becomes snoozed (it remembers
  which threads it has seen snoozed), and on an archive and a removal as before.
* **Sidebar** (`lib/shellSections.ts`): Needs you left out every snoozed thread. A snoozed
  thread with an actionable ask (permission, question, plan, trust) is now listed there,
  and so not under Snoozed, until it is answered; a finished turn or a nudge on a snoozed
  thread stays under Snoozed. `attentionIds` (window title, Dock badge, cmd+shift+a) counts
  a snoozed thread only while it has such an ask.
* **The Snoozed row** (`SidebarRow.tsx`, `SnoozedWork`): a snoozed thread that works
  (`threadGroup` "working": busy, starting or waiting on its children) shows its working
  status (`RowStatus`: the icon and how long) before the countdown. The smallest honest
  change: the row stays a Snoozed row with its time.
* **Thread view**: nothing. `SnoozeStrip` reads `snoozedUntilMs` / `savedAtMs`, which stay
  set while the thread works, so it keeps saying "Snoozed until …" with Dismiss; Dismiss
  (`snoozeThread(id, null)`) works on a live thread. `SnoozeStrip` and `WaitingStrip` were
  not restyled (another change rebuilds the strip).
* **Mock daemon**: the two command descriptions it mirrors, and a scenario for the PR's
  screenshots (`POST /__mock/snooze-holds`: snoozed s-8 working, and a snoozed thread
  asking for a permission; `e2e/snooze-holds.spec.ts`, SHOTS only). It plays the user, whose
  message still unsnoozes and unarchives.

## Breaking?

Not marked breaking (`fix`). No verb, RPC, setting or SDK API was removed or renamed;
two requests gained an optional field. What an agent could do before and now cannot (send
to or unarchive another thread's archived thread, end another thread's snooze) is a
refusal of something the user had decided, which the agreed rules call a fix of how
existing things behave. Plugins are unaffected.

## Models

* Command descriptions (`thread.send`, `thread.archive`, `thread.snooze`) say it, so
  `code-foundry help` and the generated command reference do.
* The orchestrate skill's body is at its byte budget (9,700; "over budget, cut"), so the
  rule went into `reference/sidebar.md` (a new section, "Archived and snoozed threads are
  the user's decision"), and the body's pointer to that file now names archived and
  snoozed threads. The refusal itself says what to do (read it, or tell the user).
* The plugin skill's wakes reference: a snoozed thread a wake starts stays snoozed. The
  pages verbs reference: a page acts as its thread for unarchive.

## Tests

* Store (`holds_test.go`): `createdByLocked` (creator, creator's creator, unrelated,
  the thread it created, itself, the user, a removed thread in the chain, a cycle); every
  unarchiving route (send, unarchive, pin, snooze, save) for the user, the creator, the
  creator's creator, an unrelated thread, a thread the target created, and a thread on
  the user's own thread, each refusal leaving it archived, stopped, unpinned, with no item
  in its timeline and still readable; a wake to an archived thread; a message to a snoozed
  thread from an unrelated thread, its creator and a wake keeps the snooze and its time
  (also after a restart), the user's ends it; dismiss and pin by the user, the creator, an
  unrelated thread and the thread itself; the permission prompt and its answer keeping
  the snooze and its time; the time arriving while it works; setup retry on an archived
  and a snoozed thread by a thread and by the user.
* Daemon (`actions_test.go`): runs are killed when a thread becomes snoozed, not on its
  later updates while it works or asks, and again after an unsnooze and a save.
* Commands: `thread.pin` sends the asking thread from a thread's CLI and none from the
  app; `thread.send` from a thread with `by` left empty still names the thread.
* Frontend: Needs you lists a snoozed thread that asks and not under Snoozed, puts it back
  once it works or is done, counts it per space; `attentionIds` counts snoozed threads that
  ask; the Snoozed row shows the working status before the countdown, and nothing when
  it does not work.

## End to end (2026-11-19)

Isolated daemon (`CODE_FOUNDRY_HOME` a scratch directory; the scratchpad's own path is
past macOS's 103-byte socket limit), `bin/code-foundry` built from this branch, four
no-project threads on `claude-haiku-5-5[1m]` at effort low: A (the user's), B and C (the
user's), W (created by A, `CODE_FOUNDRY_THREAD=A thread new`). Then:

```
$ code-foundry thread snooze --id B --until 1h        # snoozed until 3:37 AM
$ code-foundry thread archive --id C --archived=true
$ CODE_FOUNDRY_THREAD=A code-foundry thread archive --id W --archived=true
$ CODE_FOUNDRY_THREAD=A code-foundry thread send --id B "Reply with just the word pong."
sent to thread B (#4)                                 # STARTING, BUSY, snoozedUntil 09:37:06.832Z
$ code-foundry thread wait B                          # > pong
B CONNECTED NEEDS_ATTENTION 'finished' snoozedUntil=2026-11-19T09:37:06.832Z   # unchanged
$ CODE_FOUNDRY_THREAD=A code-foundry thread send --id C "..."            # exit 2
thread C is archived, and a thread cannot message an archived thread it did not create:
only the user can unarchive it. Read it instead (code-foundry thread read C), or, if it is
needed, tell the user
$ CODE_FOUNDRY_THREAD=A code-foundry thread send --by= --id C "..."      # exit 2, the same
$ CODE_FOUNDRY_THREAD=A code-foundry thread archive --id C --archived=false   # exit 2
$ CODE_FOUNDRY_THREAD=A code-foundry thread pin C --pinned=true              # exit 2
$ CODE_FOUNDRY_THREAD=A code-foundry thread read C                           # its 3 items
C DISCONNECTED archivedAt=2026-11-19T08:37:07.211867Z                         # still archived
$ CODE_FOUNDRY_THREAD=A code-foundry thread snooze --id B --clear            # exit 2
thread B is snoozed, and a thread cannot dismiss the snooze of a snoozed thread it did
not create: only the user ends a snooze. A message still reaches it, and it stays snoozed
$ CODE_FOUNDRY_THREAD=A code-foundry thread send --id W "Reply with just the word back."
sent to thread W (#5)                                 # STARTING, archivedAt unset; > back
$ code-foundry thread archive --id C --archived=false # unarchived (the user)
$ code-foundry thread send --id B "Reply with just the word done."
B snoozedUntil=None                                   # the user's message ends the snooze
```

The daemon was stopped by its pid; the scratch home and the four Claude transcripts the
no-project threads wrote under `~/.claude/projects/<home>/` (found by their session ids
in the scratch database) were deleted.

## Gotchas

* A no-project thread runs Claude in the home directory, so its transcript lands in the
  real `~/.claude/projects` even with a scratch `CODE_FOUNDRY_HOME`: clean it by session
  id after an end-to-end run.
* The CLI reports a FailedPrecondition with exit 2 and a usage line, as other refusals.

## Daemon restart

Yes: new request fields and new refusals in the daemon; no migration.
