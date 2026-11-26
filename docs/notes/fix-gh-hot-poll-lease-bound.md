# gh store: bound the hot poll for a pull request that never resolves

PR #908's hot poll (`PullRequestHot`, every 15 s) polls a leased open pull request while
its checks are pending, its mergeability is `UNKNOWN`, or it was just mutated. Its note
said a lease left untouched for 5 minutes lapses. But `FullPullRequest` renews the lease
on every read and the GUI re-reads an open detail panel every 60 s
(`PULL_REQUEST_DETAIL_KEEPALIVE_MS`), so the lease never lapsed while a panel was open:
a required status that never reports, an approval gate, or a mergeability stuck at
`UNKNOWN` was polled every 15 s for as long as the panel stayed open and the window
visible (480 hot polls in 2 hours in `TestHotPollNeverResolvingPRIsBounded` before the fix).

## Decision

The lease keeps meaning "someone is looking". A second clock, the quiet window
(`DefaultHotQuiet = 15m`, `hotLease.quietSince`), decides whether looking still earns
fast polls: a leased PR is eligible only while it changed within the window. The window
restarts on

- a hot poll seeing the PR's state (fingerprint, draft, mergeable, merge state) differ
  from what the previous hot poll saw;
- a read returning a different state than the read before (a change the regular poll
  saw and a refetch brought in);
- a local mutation (`touchHotMutated`, `patchFull`);
- a new lease: none, or the last one lapsed (the panel was closed for 5 minutes and is
  opened afresh).

A keep-alive read returning the same state renews the lease and nothing else.

Why a quiet window over the alternatives:

- Backing off the per-PR interval keeps a never-resolving PR polled forever (at a lower
  rate) and needs per-PR due times inside one batched `nodes(ids:)` request; a window
  needs one timestamp and keeps the batch as it is.
- Counting unchanged polls is the same thing measured in polls; a duration does not
  change meaning when `HotPollInterval` does and reads like the lease beside it.
- Renewing the lease only on change would also drop the "someone is looking" signal, and
  a panel left open would then be treated as opened afresh every 5 minutes.

15 minutes (the owner's choice over the 10 first proposed): the window measures the
longest gap between check completions, not the whole CI run, since every finished check
restarts it. A single long job is the case it cuts short; 15 minutes covers most of those
at up to 60 requests per stuck episode.

## Gotchas

- The read state and the hot-poll state are each compared only with their own previous
  value. Comparing across them would restart the window on every poll when they
  disagree for good: `hotMetaOnlyRegressedToUnknown` keeps the cache's resolved
  mergeability while the hot poll keeps seeing `UNKNOWN`.
- A panel closed and reopened within the 5-minute lease, on a PR that has been quiet for
  15 minutes and whose state has not changed, is not hot again: the store cannot tell
  that read from a keep-alive read without a new API field. The regular 60 s poll still
  covers it.
- Hover prefetch reads `FullPullRequest` too, so it leases a pending PR afresh as before;
  that lease now also stops after the quiet window.

## Cost

Figures below are calculated from the code, not measured on GitHub.

- Never-resolving PR, panel open in the foreground: at most 60 `PullRequestHot`
  requests (1 point each) after its last change, then 0 per hour. 60 is
  `DefaultHotQuiet / HotPollInterval`, reached only when the hot timer was already armed
  by another PR at the open; an open arms it one interval later, giving 59
  (`TestHotPollNeverResolvingPRIsBounded` counts exactly 59), and a healthy 60 s regular
  poll takes every fourth slot, giving about 45. Before: 180 to 240 per hour, unbounded
  in time.
- All 8 slots never resolving: the same, since one request carries all of them; hot
  polling stops 15 minutes after the last restart of any of their windows. The 4 req/min
  ceiling is unchanged and is reached only while real changes or user actions (opening,
  prefetching, mutating PRs) keep restarting windows.
- What it gives up: when nothing changes for 15 minutes (one long job, mergeability
  `UNKNOWN` for longer than that), the end is noticed by the regular 60 s poll (30 s on
  average, 60 s at worst, plus the refetch) instead of within 15 s.
