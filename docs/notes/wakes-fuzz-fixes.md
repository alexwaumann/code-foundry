# Wakes fuzz fixes

Five findings from a fuzz pass over the wake changes (#606 #607 #608 #609 #590 #566), fixed in
one PR. The scenarios were reproduced live on a scratch daemon with Sonnet 5.5 threads, before
the fix by the fuzzer and after it here.

## 1. Held wakes survive a daemon restart (high)

A group's held wakes (`s.groups`, `--notify-group`) and a lead's held wakes (`s.held`) lived in
memory only. The settle each one stands for had already fired, so the subscription's
`LastFiredAt` covered it, and `planRestartWakes` had nothing to send. If a sibling was busy at
the stop, the parent got the restart notice without the held member's last message. If the
sibling was idle, waiting on a background shell, nothing was interrupted and the parent was
never woken.

Fix: `Shutdown` calls `suppressHeldLocked` once `m.closed` is set. It records every held wake on
its subscription as the stop suppressing it (`SuppressedAt`, saved), the same as a settle that
comes during the stop. The next start's `DeliverRestartWakes` fires them with the notice, as one
message. A held one-shot's subscription was already deleted when it fired, so it is saved again.
The restart's fire then takes it (`firedLocked` removes a one-shot). Restart parts never go
through the group or lead hold, so they cannot be held a second time.

Tests: `TestHeldWakesSurviveARestart` (group with a busy sibling, group with a sibling waiting on
a shell, a lead with busy workers, a lead's one-shot). Each one stops, opens a new Manager on the
same DB, calls `DeliverRestartWakes`, and asserts one wake carrying `"last_message": "HELD-DONE"`.
The threads in these envs have no runner, so `leftByStop` writes the rows as a real stop leaves
them, without a commit (a commit would fire and release the group before the stop).

## 2. Archiving a group member (medium)

The archive drops the member's subscriptions before its close. That releases the group at
once, but `ArchivedAt` is stamped only after the close, which took 10 s live ("claude did not
exit after stdin closed"). Meanwhile `siblingsOf` counted the member as a settled child
("All 3 settled"), and `archivedTargets` dropped any part about it, so nothing named it.

Fix (`archive_group.go`):
- `record.archiving` is set from before the unwatch until the archive ends (`archiveFrom`'s
  defer; also after a put-away at the end of a turn, in case it fails before reaching that
  defer). `kidsLocked` and `siblingsOf` leave such a thread out of the counts.
- Who asked: the API passes `by_thread_id` in `thread.ArchivedBy(ctx, …)`. A self-archive at
  the end of a turn uses the thread's own id. "" is the user, or a plugin.
- When the archiver is not the subscriber, the member goes in `s.groupArchived[subscriber][group]`.
  This happens only if the group has held wakes or a member still working, since otherwise no
  wake would say it. The group's released wakes carry it as `siblings.archived`, and the header
  gets `"sleeper" (s-…) was archived.` A subscriber that archives its own child hears nothing:
  it knows already.

Test: `TestGroupMemberArchived`, with the user, another thread and the subscriber as archiver.
It uses the fake's `CF_FAKE_CLAUDE_EXIT_DELAY` for a slow close and asserts the wake goes before
`ArchivedAt` is set. Live: the wake went at 12:26:48 and the archive landed at 12:26:57. The wake
read "All 2 of your child threads settled. "sleeper" (s-e1b0fc93432e) was archived."

## 3. The orchestrate brief on a repo with no remote (low)

The brief told children to push to `origin` and to report `blocked` on any failure. On a repo
with no remote, every child reported `blocked` for finished work. A blocked report skips the
group hold, so the parent also got one wake per child. The brief now says: push when the repo
has a remote (with none, committing is done), and report `blocked` only when the work itself
cannot be finished. `reference/patterns.md` §0 says the same. Both are pinned in
`rules_test.go`. The SKILL.md body is 9395 of its 9700 bytes. Live with a natural prompt, both
children filed "finished", and the parent got one group wake.

Not changed: Ember's SKILL.md has a similar line but opens PRs only when the user asked. Its
blocked rule is about missing keys and accounts, and the fuzz did not exercise it.

## 4. GUI wake rows (low)

`lib/wake.ts`:
- `kind: "ask"` gets its own line: attention tone, the asking thread as the link, "asks", and
  the question's first line as the summary. Before, the raw daemon title showed with a green
  check.
- A thread line falls back to the first line of `last_message` when the report has no summary.
  Since #606 the daemon's own `finished` sends `report: null`.
- A `blocked` report gets the attention tone.

Tests in `wake.test.ts`. The mock's lineage parent now has an ask wake and a no-report finished
wake. A SHOTS-gated spec in `e2e/lineage.spec.ts` screenshots the rows for the PR.

## 5. A message read mid-turn does not restart the turn (low)

`lastTurn` reset `started` on every top-level user message, and a steer or an ask's answer is
one. The fix starts a turn at the first top-level user message after the previous `turn_end`.
That is sound because `queued.go` moves a queued message to where Claude read it, and a message
read as the reply ends lands after the result, so it starts a turn of its own. Unread `Queued`
items are skipped. The last assistant text is unchanged: it is still the text after the last
user message. `recordTurnReport` and `wakeDetailOf` (`started_at`, `ran_for`, `staleReport`)
both read it. A `blocked` report filed before a steer in the same turn stays the turn's report.

Tests: `TestLastTurn`, `TestTurnReportAcrossASteer`, and new rows in `TestDetailOf` and
`TestWakeDetailOf`. Two old rows modelled a follow-up as two user messages with no turn end
between them. They now have the turn end a real follow-up has. Live: the answer to an ask was
read mid-turn, and the wake said `started_at` was the brief's time with `ran_for` 12s for the
whole turn.

## Gotchas

- `TestThreadWakeDetailDelivered` fails about 1 run in 4 on origin/main too (no
  `last_message`), and was not touched here.
- The live runs used 14 Sonnet 5.5 threads at medium effort: two restart repros, the archive,
  the ask, and a natural orchestration on a repo with no remote.
