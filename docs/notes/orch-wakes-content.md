# Wake content: batches, sibling counts, words after a report, held lead wakes (2026-10-19)

From the orchestration battle test of 2026-10-19 (`/tmp/cf-exp2/results/REPORT.md`):
A2 (burst wakes give a false status: E1 §4 item 3, E5 friction 2, E7 F2, W1 finding 3,
E3 item 1), A3 (what a child says after its report never reaches the parent: E1 item 1,
E2 item 1, E5 friction 4, W1 finding 2) and A6 (lead progress wakes cost the parent a
turn each: E5 friction 1). Daemon wake engine (`internal/store/thread`), the GUI's wake
note, one clause of the guide. Follows `agents-4-wake.md` and `wake-detail.md`; the
locking rules hold: the hook decides and queues under `m.mu`, a thread wake is built in
the subscriber's drain goroutine.

## Decisions

* **Batch window: 1 s after the last thread wake, at most 5 s after the first**
  (`WakeBatchWindow`, `wakeBatchHold`; `Options.WakeBatch`, negative turns batching
  off). The drain no longer sends a thread wake at once: it holds it until 1 s has
  passed since the latest thread wake queued for that subscriber, then takes every
  thread wake queued meanwhile, plus any queued behind a delivery that was in flight.
  The evidence had bursts of 5 ms to 1.3 s; a trailing window catches a 1.3 s chain of
  children while a single wake costs 1 s of latency (was 0.1 s). The 5 s cap keeps a
  steady stream from holding wakes forever. The window runs on the monotonic clock
  (`time.Now`), not `Options.Now`.
* **What is batched**: thread wakes (any condition). Run, pull request, plugin and
  removed wakes go alone and at once, as before; a thread batch may overtake one of
  them queued meanwhile. One thread wake alone keeps the single shape exactly.
* **The batch message**: the header is `N threads settled: ` (or `N thread wakes: `
  when a condition other than settled is in it), then each wake's own header sentence
  in fire order, then the siblings sentence once. The JSON is `{"kind": "batch",
  "wakes": [<the per-thread payloads, unchanged>]}`. `WakeTitle` is the whole header.
* **The wake limit counts a batch as one**: a thread wake that joins a batch already
  waiting (drain holds one, or one is queued) takes no slot (`joinsBatchLocked`); a
  batch whose wakes are all held gives its slot back (`refundLocked`). `FiredCount`
  still counts every fire.
* **Siblings** (`thread.siblings`, on every thread wake whose target's `created_by` is
  the subscriber): `{settled, total, working: [{id, name}], pending: [{id, name,
  reason}]}` over the subscriber's live children (not archived, not being removed),
  counted when the wake is sent, not when it fired (in a burst the others have settled
  by then). The targets count as they fired; `working` and `pending` list the others
  only (`pending`: a running child at a permission prompt or question, `requestKey`).
  A lead with a progress report whose own workers still run counts as working (its
  wake was held: below). The header sentence, after the wake's own: `3 of your 4 child
  threads settled; still working: "Tests" (s-…); waiting on an answer: "Docs" (s-…).`,
  `All 4 of your child threads settled.`, nothing for an only child; three names per
  list, then `and N more`.
* **`last_message` after a report (A3)**: when the turn ended (`Meets(idle)`) with a
  current report and the turn's last assistant text is newer than the report
  (`Item.CreatedAt` after `Report.At`), the JSON has `last_message` (one line, 500
  runes, as before) and the header says `…: finished, said more after its report.
  Report: done — …`. `report_stale` keeps its meaning (false here); the report is still
  quoted. No new JSON flag: `last_message` with `report_stale` false says it.
* **Held lead wakes (A6)** (superseded by `ember-fixes-1-wakes.md`): a wake is held
  when its subscription is settled and repeat (`--notify`'s), the turn ended plainly (idle, or needs attention "finished"; not an
  error, a prompt, the budget), the target's report is `progress` and current, and its
  children counted at the fire have any working (`heldLeadWake`). It is counted
  (`FiredCount`, `LastFiredAt`; `thread subscriptions` shows it), logged `wake held:
  lead still has N workers`, and not sent. The next settle fires as usual: when the
  last worker's wake makes the lead report `done`, the parent wakes. A one-shot or an
  `idle`/`attention` subscription is never held (it asked for this very change).
* **Archived meanwhile**: a batch whose subscriber was archived or removed while it
  waited is dropped (`forgetLocked` already dropped the queued ones; the window made
  the race real for the one in hand).
* **GUI**: `wakeLines` gives one "Woken by …" line per wake of a batch, each with its
  own payload as the body; `UserRow` draws one `WakeNoteRow` per line. A single wake is
  drawn as before.
* **Guide**: the "end your turn" convention now ends `settles (wakes at once: one
  message; a lead's progress while workers run: none).` The guide is at its
  29,000-byte cap (`TestGuide`): main's skill-v3 PR used the headroom, so the
  Connect/proto line in "Discover more" was cut to `The API: Connect over the daemon's
  socket; protos: code-foundry's proto/codefoundry/v1.` to make room.
* **Skill**: owned by the skill PR (#240, on main), whose Leads section already says the
  daemon holds a lead's progress settle while its workers run. Two follow-ups for it:
  that paragraph says the parent is woken "when a worker needs someone", but a worker's
  prompt wakes the lead (its subscriber), not the parent, and the lead's own next settle
  is held again while it has a fresh progress report and workers running; and the "look
  at the whole batch, wakes can arrive seconds apart" line can now point at the batch
  message (`N threads settled: …`, `wakes` array, the siblings sentence).

## Gotchas

* The thread package's test env turns batching off (`WakeBatch: -1`): the existing tests
  count wake messages and settle children back to back, which now batch. The batch
  tests set short windows (60 to 300 ms) on real time.
* `Report.At` is stored at millisecond precision and items are not: text created in the
  same millisecond just before the report could read as "said more"; a Bash call between
  the two takes far longer, so it is not handled.

## End to end (2026-10-19, isolated home, Haiku 5.5 medium)

`make build`; daemon `CODE_FOUNDRY_HOME=/tmp/cf-build-owc code-foundry daemon --dev` with
the branch's `bin` first on PATH; `threads.default_model 'claude-haiku-5-5[1m]'`, effort
medium; scratch project `~/cf-exp2-scratch/owc-todo` (from `todo-template`, bare
origin). A Haiku orchestrator (s-bd13994dd143) ran one script making three `--notify`
children: Alpha and Beta wait for a shared wall-clock time, `report done`, then end with
a "Caveat: …" sentence; Gamma is a lead that makes one worker (also `--notify`), files
`report progress`, ends its turn, and reports `done` when the worker's wake comes.

Daemon log (cut):

```
09:38:08.707 wake subscription fired subscriber=s-bd13994dd143 target=s-96784db5f5e4 (Gamma) fired_count=1 joins_batch=false
09:38:09.709 wake held: lead still has 1 workers target=s-96784db5f5e4
09:38:34.439 wake subscription fired target=s-bb1011df01e0 (Beta) joins_batch=false
09:38:34.824 wake subscription fired target=s-eb83011dc90a (Alpha) joins_batch=true
09:38:35.827 woke thread subscriptions="[sub-ec2cfc6dea98 sub-72a28912cf0a]" wakes=2
09:39:05.868 wake subscription fired subscriber=s-96784db5f5e4 (Gamma) target=s-f5b95937cf6b (Gamma worker)
09:39:09.411 wake subscription fired subscriber=s-bd13994dd143 target=s-96784db5f5e4 fired_count=2
09:39:10.413 woke thread thread=s-bd13994dd143 wakes=1
```

`thread read s-bd13994dd143 --full`:

```
#4 claude: started
#6 wake: 2 threads settled: Thread "Beta" (s-bb1011df01e0) needs attention: finished, said more after its report. Report: done — Beta finished. Thread "Alpha" (s-eb83011dc90a) needs attention: finished, said more after its report. Report: done — Alpha finished. 2 of your 3 child threads settled; still working: "Gamma" (s-96784db5f5e4).
#7 claude: WAKE 2 threads, 2 of 3 child threads settled.
#9 wake: Thread "Gamma" (s-96784db5f5e4) needs attention: finished, said more after its report. Report: done — Gamma team done. All 3 of your child threads settled.
#10 claude: WAKE 1 thread, 3 of 3 child threads settled.
```

The first wake's JSON (`thread items --json`, cut): `{"kind": "batch", "wakes": [{…
"thread": {"id": "s-bb1011df01e0", "name": "Beta", …, "report": {"status": "done",
"summary": "Beta finished", …}, "last_message": "Caveat: Beta skipped the tests on
purpose.", "siblings": {"settled": 2, "total": 3, "working": [{"id": "s-96784db5f5e4",
"name": "Gamma"}], "pending": []}}}, {… Alpha, "last_message": "Caveat: Alpha changed
nothing real; this was only a wake test.", the same siblings …}]}`. Gamma's progress
settle (09:38:08) started no orchestrator turn; `thread subscriptions --all` shows its
subscription `FIRED 2` (the held fire and the delivered one). Alpha and Beta settled
385 ms apart and went as one message 1 s after the second. The GUI (built with `make
gui-build`, run against the same home) draws the batch as two "Woken by" rows, Beta and
Alpha, in dark and light. No ERROR lines in the daemon log; daemon and GUI stopped
afterwards.

## Daemon restart

Needed: the wake engine is daemon code. The GUI change is the wake note only.
