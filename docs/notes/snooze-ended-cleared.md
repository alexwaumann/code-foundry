# Snooze ended cleared by archive and snooze; card place as text

## Snooze ended

A woken thread reads needs-attention "snooze ended" until it is reconnected
(snooze-threads-1-daemon.md). Archiving or snoozing it again kept that status, so a user
had archived and snoozed rows still saying "Snooze ended".

- `clearSnoozeEnded` (internal/store/thread/snooze.go) turns needs-attention "snooze ended"
  into idle "at prompt". Snooze and Archive (archiveFrom) call it under m.mu, in the same
  commit as the snooze or archive. Idle "at prompt" because that is where a woken thread is:
  disconnected, with no turn running.
- The fix only touches "snooze ended". An archived thread that still reads "finished" is
  left alone: nobody reported that, and the sidebar already shows archived rows quietly.
- Rows archived or snoozed before this change are settled once in `New`: a loaded thread
  that is archived or snoozed and reads "snooze ended" goes idle "at prompt" and is saved.
  A woken thread still in the list keeps its status.
- A re-snoozed thread that wakes again gets "snooze ended" stamped again, as before.

## Thread card place

The sidebar thread card's project row showed where the thread runs (Fresh copy, Project
folder) as a chip. It is now muted text on the right (`TipRow`'s `meta`, test id
`tip-project-meta`), like the workspace row's "N projects". The "no git" chip stays a chip:
it says something is missing, not where the thread runs.
