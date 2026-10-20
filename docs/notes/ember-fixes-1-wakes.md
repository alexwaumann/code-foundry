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

The daemon ran from this branch in `CODE_FOUNDRY_HOME=/tmp/ember-fixb-home`, on Haiku 5.5
(medium), against a scratch repo under `~/scratch-ember-fixb`. Both were deleted
afterwards.

**Run 1: a lead with 3 workers, no progress report.** "Top" ran
`thread new --created-by Top --notify` for "Poems lead". The lead started three workers
with `--notify` and was told not to post a progress report.

- 08:11:41 the lead's first turn ended with no report. Its settle fired (fired_count 1),
  and the log has `wake held: lead still has 3 workers`. Top showed "waiting (on 1
  child)".
- The workers' wakes went to the lead (1, then 2 batched). The second came mid-turn, so
  the lead did not settle in between.
- 08:11:59 the lead reported done and settled (fired_count 2). Top got its one wake:
  `Thread "Poems lead" (…) needs attention: finished, said more after its report.
  Report: done — All 3 poems done. …`, with `children: {working: 0, reported: 3, total:
  3}`.
- Top's thread has exactly 1 wake. Before the fix, the no-report first turn alone would
  have woken it (#83 in the battle test).

**Run 2: a lead that settles between workers, plus a sibling.** "Top 2" had two
children: "Lead 2" (3 workers, staggered) and "Solo" (a plain thread). The lead's
intermediate turns ended in prose with no new report.

- The lead settled 5 times (fired_count 1 to 5). Settles 1, 2 and 3 were held:
  `wake held: lead still has 3 workers`, then `2 workers`, then `1 workers`. Settle 4
  (report done, team settled) woke Top 2.
- Settle 5 also woke Top 2: `finished (report is from before its last message). All 2
  of your child threads settled.` A worker re-settled after the lead was done (its
  background `sleep` ended and woke the lead), and the lead's team was settled by then.
  The rule allows this; it is not the D1 case.
- D2: Solo's second wake (08:13:00) came while Lead 2 was settled but held with 2 workers
  running. It read `1 of your 2 child threads settled; still working: "Lead 2" (…)`.
  The old code counted the lead as settled ("All 2 …") unless it had a fresh progress
  report.
- Top 2 got 4 wakes: Solo twice (it settled twice), and Lead 2 twice (its done report,
  and the late re-settle). The old rule would have sent 3 more, for the lead's
  intermediate settles.

**Consolidation usage.** `ember.model` was set to Haiku 5.5, Ember got one message, and
`ember reseed` ran the consolidation.

- `ember status` printed `consolidation cost: last $0.0006 (3.5K in, 104 out), $0.0006
  over 1 call`. The log has `ember: consolidation usage cost_usd=0.00062069
  input_tokens=3461 output_tokens=104`, and `state.json` has both records.
- That call's answer was a Haiku refusal ("…the output I was given is an environment
  block…"), so MEMORY.md was kept. Its usage was still recorded, as intended.
- Run by hand on the same input, `--output-format json` gave a `# Memory` answer 3 out
  of 3 times, and plain text 2 out of 2. The refusal is the model, not the format.
- A second reseed succeeded: `last $0.0004 (3.5K in, 366 out), $0.0011 over 2 calls`.
  The line was the same after a daemon restart.

## Gotchas

- `TestThreadWakeDetailDelivered` used a settled subscription on a lead with no report
  and busy workers, which is now held. It uses an attention subscription instead.
- The thread store's fake claude replays one turn per process. The subscribed-lead test
  closes the lead after each wake turn, so the next wake starts a new process.
- Observed, not changed: a failed consolidation still moves `LastConsolidatedAt`
  (epoch.go), so the next one's input skips the conversation of the failed one. In run
  2, the "two sentences" preference from before the refused call was not in the second
  MEMORY.md.
