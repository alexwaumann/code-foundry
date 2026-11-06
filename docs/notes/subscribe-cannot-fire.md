# thread subscribe says when a wake can never fire (2026-11-06)

A `checks_passed` subscription on a closed pull request was accepted and then said
nothing: the checks conditions need the pull request open. An eval showed models reporting
such a watch as set up, and the user waiting forever. `thread.subscribe` now refuses what
cannot fire and warns about what may not, and a subscription a reported close or merge
leaves unable to fire gets a last wake and ends.

**The rule: nothing ends a subscription or fires a wake because of a cached copy that was
not reported as a change.** A cached copy can predate a reopening (a branch list stays in
memory after its watch ends), so it decides nothing. An earlier version settled
subscriptions from the cache after every poll, and it could end a healthy subscription or
fire a false `closed`.

## Where it lives

| Piece | Where |
|---|---|
| The question, refusals, last wake, warnings | `internal/store/thread/subscriptions_cannot_fire.go` |
| Ending on a change, retry | `PullRequestChanged`, `retryFinalWakesLocked` in `subscriptions_pr.go` |
| Fresh read | `gh.Store.LookupPullRequest` in `internal/store/gh/pr_watch.go` |
| Glue | `lookupPullRequestForWake` in `internal/daemon/wake_pr.go` |
| Reaching callers | `SubscribeThreadResponse.warnings`, `Result.Warnings` in the command |

The handler and the command stay thin. The CLI prints warnings to stderr as `warning: …`,
and `--json` carries them too, as does the response of every other caller.

## At subscribe time: ask once

`Subscribe` asks GitHub about the pull request directly, before taking any lock, for at
most 5 s (`prLookupTimeout`). The lookup goes through the store's job queue but past both
caches: `Store.PullRequest` would serve a detail up to `DetailTTL` old, or an old one on
failure, so it does not fit.

| GitHub's answer | Condition | Result |
|---|---|---|
| open | any | kept; checks already met fire at once (existing) |
| closed | `closed` | fires at once (existing) |
| closed | `changed` | kept, with a warning: it hears a reopening or a new title |
| closed | any other | refused: reopen and subscribe again, or `--until changed` |
| merged | `merged` | fires at once (existing) |
| merged | any other | refused: act on the merge |
| not found | any | refused: check the owner, name and number |
| no answer (rate limit, network, forbidden, timeout) | any | kept, with a warning; nothing fires |

`merged` is among the refused on a closed pull request: it cannot merge closed.
`diffPullRequest` compares reviews, comments and review requests only between two open
copies, so `comment`, `review` and `review_requested` need it open too.

**A "not found" must be GitHub's.** The real one comes back as a `PartialError` beside a
null pull request, and `errors.Is(err, ErrNotFound)` is also true for a nested `NOT_FOUND`
beside the pull request. So `fetchPullRequest` keeps what a partial answer holds, and
`LookupPullRequest` counts an answer holding the pull request as found.

With no answer the subscription uses nothing from the cache: a met condition does not
fire, and the warning says it went unchecked.

## Other sources

| Source | Condition at subscribe time | Choice |
|---|---|---|
| thread | archived | refuse (existing; now says to unarchive) |
| thread | stopped, condition not met | warn: fires only if someone sends it a message |
| plugin | enabled but not running or starting | warn: it re-arms when it starts |

The other refusals (subscriber or target gone, a loop, an unknown run, a past timer, a
disabled plugin) and already-met wakes are as they were.

## After that: only change events

`PullRequestChanged` reads the state off the event, which is the poll's fresh copy:

* A subscription the event meets fires as before. `merged` and `closed` go even with
  repeat, and so do those on a state they also met without the matching change (`closed`
  kept unchecked, then a title change on the closed pull request).
* Otherwise, one that cannot fire any more (`prCannotFire`) gets a last wake and goes: one
  wake each, its JSON with `"ended": true` and the subscription's own condition. A close
  leaves only `changed`. This replaces "a closed one keeps the others" from
  `gh-events-3-pr-wake.md`, and a merge no longer deletes them without a word.
* One that fired and also cannot fire goes with that wake, not a second one.

**The wake limit.** A subscription goes only when its wake was accepted into the
subscriber's queue. A dropped last wake stays on the record (`subRec.final`) and
`fireTimers` tries it once a minute, as it does a dropped timer. The subscription goes with
the wake that gets through, so a retry is one wake. Any later event replaces it, so a
reopening calls it off. `merged` or `closed` already true at subscribe time, dropped at the
limit, waits the same way: nothing else would fire it.

## Known gaps

All existing limits but the last three, none fixed here:

* A pull request that disappears from its branch list and never reports a change: its
  subscriptions stay armed, silently.
* A repository lost after subscribing (deleted, or access gone): the poll reports no
  change, so nothing is told.
* Reads that keep failing: no events, so wakes come late or never.
* A wake accepted into the queue is lost if the daemon stops before it is delivered. Its
  subscription is already gone, so "accepted" does not mean "delivered".
* A checks edge dropped at the wake limit is not retried: a one-shot stays armed for the
  next change into the condition.
* A close or merge while the daemon was stopped: branch rows load on demand, so a branch's
  first poll after a start only records. `merged` is missed, and the others stay armed.
* A run subscription is dropped at startup without a word (`loadSubscriptionState`).
* Without a GUI the poll is 15 minutes apart, so a close is told that late.
* New here: a last wake waiting at the limit is in memory, so a restart forgets it and the
  subscription stays armed, as after a close while stopped.
* New here: a subscription kept on a failed lookup has no second check. If the pull request
  is closed, merged or missing, it waits silently after that one warning, unless a change
  is reported.
* New here: a close between the lookup and the first poll of the branch can go unreported,
  since a list's first poll only records. Subscribing brings that poll forward, so the
  window is seconds.

## End to end

2026-11-06, `CODE_FOUNDRY_HOME=/tmp/cf-rework/home`, the branch binary through a wrapper
unsetting `CLAUDE*` and `CODE_FOUNDRY_*`, `daemon --dev`, a no-project thread (Sonnet 5.5
medium, supervised), reads of this repository's real pull requests. Each answer took 0.5 to
1.7 s, with the machine busy.

```
$ cf thread subscribe --pr …#515 --until checks_passed     # closed; the same for comment, review, review_requested, merged, head_pushed
code-foundry thread.subscribe: pull request alexwaumann/code-foundry#515 is closed, so checks_passed cannot fire; reopen it and subscribe again, or use --until changed to hear if it reopens
$ cf thread subscribe --pr …#515 --until changed
warning: pull request alexwaumann/code-foundry#515 is closed, so this fires only if it reopens or its title changes
subscribed sub-66fc08f3f150: … changes (once)
$ cf thread subscribe --pr …#515 --until closed
woke s-145a77bf67e5 at once: pr alexwaumann/code-foundry#515 already met the condition (closed); the one-shot subscription sub-966d807f0294 is done
$ cf thread subscribe --pr …#543 --until checks_done       # merged; the same for closed, changed
code-foundry thread.subscribe: pull request alexwaumann/code-foundry#543 is merged, so nothing more will happen to it; act on the merge now instead of waiting
$ cf thread subscribe --pr …#543 --until merged
woke s-145a77bf67e5 at once: pr alexwaumann/code-foundry#543 already met the condition (merged); the one-shot subscription sub-119390109fe9 is done
$ cf thread subscribe --pr …#999999 --until checks_done    # also a repository that does not exist
code-foundry thread.subscribe: pull request alexwaumann/code-foundry#999999 does not exist, or this GitHub login cannot see it; check the owner, name and number
$ cf thread subscribe --pr …#590 --until comment           # open
subscribed sub-4fcb436c6e25: … gets a comment (once)
```

The subscriber's items held the two at-once wakes. Then the same home with GitHub
unreachable (a dead `HTTPS_PROXY` on the daemon), closed, merged and missing pull requests
all stayed, and `--json` carried the same warning:

```
warning: could not check pull request alexwaumann/code-foundry#515 on GitHub (paused until 03:11:17: cannot reach github: …), so it was subscribed unchecked: it may be closed, merged or missing, and this may never fire
subscribed sub-a523eeb6f99b: … passes its checks (once)
```

No ERROR lines in either log. No real pull request was changed for this, so a close or
merge after subscribing is covered by tests only: `TestPullRequestEndsSubscriptions`,
`TestFinalWakeAtTheLimit`, `TestReopeningCallsOffAFinalWake`, `TestReopenedSubscribesAgain`
and `TestStaleCachedClosed`.

## Daemon restart

Needed: the new response field and the store rules.
