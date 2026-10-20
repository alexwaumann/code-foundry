# Ember fixes 1: held lead wakes, sibling counts, consolidation usage (2026-10-20)

Fixes D1, D2 and D5 of `ember-experiments-2026-10-20.md`.

## D1: the hold rule

A settled wake about a thread L (a lead) is held, not sent, when all of these hold:

1. The subscription's condition is `settled` (repeat or one-shot; `idle` and `attention`
   subscriptions asked for this very change and are never held).
2. L's turn ended plainly as it fired: status idle (at prompt, or shown "waiting on N
   child threads"), or needs attention "finished". A pending permission prompt or
   question, an error, the budget stop, a snooze end or the wake limit is never held.
3. L's report is not a current `done`, `failed` or `blocked` one. No report, a
   `progress` report, or any report filed before L's last message (stale) is held.
4. L had working children when the wake fired (`children.working > 0`).
5. When the wake is about to be sent (`holdLocked`, under the store lock), L still has
   a working child, or L is not quiet.

A child works (`threadWorking`) while it is not settled (busy, starting, being
removed), is shown waiting on threads of its own, or has a working child of its own
(the walk goes down the whole team; archived threads are left out). L is quiet when it
is settled, not shown waiting, and no wake is queued to it or being delivered. A
child's pending request counts through its wake to L: until L was told, L is not quiet.

A held wake is counted (`FiredCount`) and logged `wake held: lead still has N workers`.
It takes no wake limit slot (a batch that sends nothing refunds it). L's status reason
is unchanged: "waiting on N child threads" when it subscribed to its workers.

Release, one wake:

- A new fire of the same subscription replaces the held one. A lead subscribed to its
  workers (`--notify`, the skill's way) is woken by the last one, ends that turn with
  no working child, and that settle wakes the parent the ordinary way.
- Otherwise the held wake goes, as a wake about L as it is then, once L is quiet with
  no working child. This is checked on every commit of L or of any descendant (the walk
  goes up `created_by`), when one of L's children is removed, and when a wake queue
  empties. The log says `wake released: the lead's children settled`.
- A held wake is dropped when its subscription goes (unsubscribe, a one-shot's own
  removal happens before the hold), when its subscriber or L is archived or removed.
  Held wakes live in memory; a daemon restart drops them (its restart notice wakes
  every subscriber anyway).

The lead's own pending request, error, budget stop or done/failed/blocked report goes at
once because it is a fire that rule 2 or 3 does not hold.

## D2: sibling counts

`siblingsOf` now counts any child of the subscriber with a working team (`teamWorking`
> 0) as working, the wake's target included, and lists it under "still working". The
JSON `children.working` of a lead's own wake counts the same way (a sub-lead waiting on
its workers is working). `wake-detail.md` and the orchestrate skill's
`reference/leads.md` say so.

## D5: consolidation usage

The consolidation call adds `--output-format json`. `consolidationResult` reads the
result object (`claudestream.Result`): the answer is `result`, the usage is the sum of
`modelUsage` (input = uncached + cache reads + cache writes; output), the cost is
`total_cost_usd`. Anything that is not a result object is the answer itself, so a
runner that prints plain text (the tests' fakes) still works. A result marked
`is_error` is a failed consolidation, and its usage is still recorded.

The store keeps `last_consolidation_usage` and `consolidation_usage_total` (with a call
count) in `state.json`. They are on `ember.Status` and on `ember status`:

    consolidation cost: last $0.12 (17.0K in, 800 out), $0.31 over 3 calls

The JSON has `consolidation` with `lastCostUsd`, `totalCostUsd`, the tokens and `calls`.

Left out:

- The proto. `ember status` reads the store directly, and the GUI does not show this, so
  no `ConsolidationUsage` message was added. That keeps generated code out of this PR,
  away from the GUI work on `ember.proto`.
- The usage page. Its fold is per-thread token buckets priced at read time, plus the
  retired ledger. Adding Ember's calls there means a new bucket source through the
  thread usage RPC, which is not a small change.

## Live evidence

TBD
