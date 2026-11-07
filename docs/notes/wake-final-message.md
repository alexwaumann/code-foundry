# Wakes carry the child's last message whole (2026-11-07)

The first of the changes from the orchestration review: a child's last message always reaches
its parent, and what git knows comes from the daemon. Measured on 453 real wakes in 120
transcripts before the change:

- 425 of 427 children wrote more text after their `thread report`: every result was summarised
  twice.
- 200 of the 259 `last_message` values were cut at the old 500-rune limit.
- 187 of 410 single-thread wakes were a report plus a cut recap that `wakes.md` said to ignore.
- 51 of 410 said the report was missing or stale.
- About 4 wake turns in 10 ran git. Most of that turned out to be the skill's pairwise check of
  whether branches fit together, not doubt about what a child said (see Results).
- Final messages ran to a median of 998 characters and 4,751 at most, about the size of the
  JSON a wake already carried.

## Decisions

- **`last_message` is whole**: every wake of an ended turn has it, lines kept, with or without a
  report. `maxLastMessage` is 16 Ki runes, a safety net over three times the longest seen.
- **Children no longer file a closing report.** `CreatedThreadPrompt`, in the system prompt of a
  thread another thread created, tells it the last message of each turn reaches its creator. It
  lives there, not in the creator's brief: the "report again after any later message" rule only
  reached 4 of 12 briefs in `guide-orchestrate-ember.md`'s variant B, and it no longer exists.
- **`ReportFinished` is the daemon's own** (`turnreport.go`). `thread reports`, Ember's board and
  the lead hold read the report row, so a created thread's normal turn end files one, summary =
  the head of the message. It never replaces a report filed in that turn, and a cut turn (an
  error, an interrupt) files nothing, so it never says more than that the turn ended.
- **`final()` leaves finished out.** A lead ending a turn with workers running files finished too,
  and that must not release its held wake or read as the task closing.
- **Ember's unclosed check counts finished**, or a worker with no closing report would never
  reach "to check". Its words are "Worker finished", not "reported finished".
- **`blocked` and `failed` stay explicit**: prose cannot be read for them, and Ember blocks a task
  on them.
- **`checkouts` come from git** (`checkoutfacts.go`), read in the drain goroutine when the wake is
  built: local refs only, 3 seconds at most, off the locks. A push moves the remote-tracking
  ref, so nothing touches the network. A checkout the thread only inherited is left out unless
  it holds work.
- **`report_stale`, "said more" and "without a report" are gone from wakes**, with
  `maxClosingWords`. A stale report is left out of the JSON. `Thread.report_stale` stays on
  `thread get`: `thread reports` still marks an old report while a thread works on.
- **`thread wait` and `send --wait` print the last message**, or a parent that waits instead of
  ending its turn would have to `thread read` for it.
- **`--data` stays** for callers that want it, but nothing asks for it any more.

## Results

Six tasks, 3 runs each, Opus 5.5 medium, Sonnet 5.5 low workers in the `home` tasks, main at
`914fc73a3` against this change. `make guide-eval-compare` read on the same six tasks.

| | main | this change |
|---|---|---|
| Child `thread report` calls | 49 | 0 |
| Parent reads of a child, whole run | 22 | 11 |
| Parent git calls, whole run | 66 | 60 |
| Facts relayed | 87 of 87 | 87 of 87 |
| Conflicting pairs, `t10` and `ember-overlap` | 0 | 0 |
| Cost | $12.46 | $11.81 |
| Guidance tokens per run | 6,576 | 7,232 |

- **The win is the report and the reads.** Children stopped filing, and parents stopped going back
  to read them.
- **The git facts did not cut git calls.** They were expected to; the calls are the skill's
  pairwise check, which needs the diffs. They stay because parents quote them ("the app confirms
  the branch is pushed") and because they are observed, not claimed.
- **Relay did not separate the sides.** Parents on main got the whole list too, by reading the child.
- **The merge gate fails alone**, on guidance tokens. The skill files moved by 2 bytes; parents just
  opened `wakes.md` and `patterns.md` more often. The whole stack holds the same text and read
  6,495 tokens, so this looks like run noise, but three runs cannot prove it.
- Cost is within what three runs can show.

## Gotchas

- Unit tests stub `CheckoutFacts`: real git in a wake's delivery delayed it enough to reorder
  `TestWakeLimit`'s wakes against the limit's status. `TestGitCheckoutFacts` runs real git.
- A turn that ended with a report from that same turn keeps it, so a child following old habits
  still works: its `done` is simply not quoted beside its own last message.
