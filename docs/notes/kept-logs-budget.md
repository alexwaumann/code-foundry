# Kept logs by size

Switching back to a thread shows its log at once while the Watch fetches. Only the last 4
threads kept one, however large: 200 KB across four small threads, or 200 MB across four huge
ones. Now the logs share a budget of about 64 MB of text, most recent first.

## Decisions

- **It stays a stand-in, never a cache to invalidate.** Every open still fetches the whole
  snapshot and that snapshot replaces the kept log, so nothing here decides what is current.
  Skipping the snapshot when nothing changed was considered and turned down for that reason.
- **Size, not a count.** A thread can hold 50 KB or 50 MB. Size is the text in the items, in
  characters: a string of mostly ASCII is about a byte each, so it is an estimate.
- **An open thread's log counts**, and is never dropped.
- **The thread just left always stays**, even over the budget: going back to it is the
  commonest switch.
- **Strict order.** Once the budget runs out everything older goes, even a small log that would
  fit. It is simpler, and the recent ones are the ones worth keeping.
- Trimmed on opening a thread and on leaving one. Leaving is where a thread that grew counts.
- Not on disk: the daemon is local and fast enough, so it would only add invalidation.

## Pending requests

A kept log can now be hours old, and it stopped following its pending requests when its Watch
closed. Until the Watch has synced, `useThreadPending` and `useOpenRequests` read the
EventService's list instead, which is live. Otherwise an answered prompt could flash in the
composer on opening.

## Gotchas

- A test that writes a log into the store as the Watch's must also set `synced` for its pending
  requests to show (`test/threadWorld.ts` does).
- The rest of a kept log (its rows, a failed prompt's notice) is still behind until the snapshot
  lands, as before. That moment is as short as it was; the log it shows can just be older.
