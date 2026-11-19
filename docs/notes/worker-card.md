# Worker card: a lead's turns its workers started read as one turn

A lead that started worker threads is woken each time one reports, asks or finishes, and each
wake was a full turn in its timeline: a "Woken by …" note, a "Worked for …" header and a reply.
Five reports meant five of each. A user asked to consolidate this. The agreed design (turn
sketches 8, 6, 5 and 3, section 2 each; the brief where they differ) reads a run of those
turns as one card with the lead's replies stacked under it, and tells the model so.

Update 2026-11-19 (`other-thread-lines.md`): a run also holds the turns that messages from
other lead threads started inside an exchange; those threads get a line each under the card,
and a message from one outside an exchange is a From row.

This corrects `agents-3-lineage-gui.md` ("Wake messages render as a lineage note"),
`orch-wakes-content.md` (GUI: one "Woken by" line per wake of a batch) and `turn-gutter.md`
(every finished turn has a header): inside a worker run, wakes and headers are not drawn. They
still are everywhere else.

## What was agreed

* A **run** is the turns of a thread its own workers started (their wakes, a worker's `thread
  ask`, a worker's `thread send`), after a turn the user started and up to the user's next
  message.
* **One card** where the run begins (right after the user's turn), updating in place. Title
  "Working with N threads" while any line is live, "Worked with N threads" otherwise; at its
  right the run's elapsed time while it is the current card, the time the user's next message
  froze it once frozen (`sentTime`, the bubbles' format). One line per worker: its name (the
  width is the name's; a tooltip only when cut), its state's word, how long it worked
  (`formatDuration` with the sidebar's `statusTimeUnits`). Working shows the working
  `StatusCircle`; the rest a dot in the status tones (`rowToneDotClasses`). A line opens the
  worker's thread (`openThread(id, { from: lead })`, as the wake note's link). Nothing expands.
* **Replies stack under the card.** A run turn that ended with a message leaves that message
  and its gutter; one with nothing for the user leaves nothing. The lead's own questions and
  permission prompts show as before (they are its turn's rows).
* **The user's next message freezes the card**: its lines stay as they were then, and it folds
  to its title line with a chevron; a click opens it, and it is folded again on the next visit
  (the thread's fold choices, which leaving the thread forgets). The current card has no fold.
* **Carry-over**: under the user's new turn a new card lists every worker still running plus
  every one that did something since that message. A finished worker nobody touched again is
  not in it; one the lead sent more work is.
* A worker waiting on the user (its own permission prompt or question) reads "needs you" or
  "asks you" in the warning tone.

## Decisions made here

* **The grouping is one pure pass after `buildRows`** (`lib/workerRuns.ts workerRuns`, rows in,
  rows out): `buildRows` is unchanged except that user and steer rows carry their sender and
  time, and a gutter may carry `fold`. A thread with no workers gets the very same array back.
* **Who sent a message** rides on the timeline's structural key (`TimelineItem.from`, `at`):
  `senderOf` turns a user item into "" (the user's), `m:<id>` (another thread's message) or
  `w:` plus one part per wake line, `t/<thread>/<done|fail|wait|ask>/<created_by>` or `x` (a
  wake that is no thread's). So a text delta still rebuilds nothing.
* **Who sent a message comes from #819's `from`** (`UserMessageItem.sent_by_thread_id`, its
  relation and reply mark; `api/replies.ts`). This branch first added the same field for the
  same reason (a worker's `thread send` read as the user's own message and would have frozen
  the card); #819 landed it while this was built, so the card reads `from.threadId`. A message
  from before the marks (no `from`) counts as the user's.
* **Who is a worker**: a thread whose `createdBy` is this thread (the threads store, one string
  selector `useWorkers`, so the timeline rebuilds only when a worker's state changes), plus a
  removed one a wake's payload says this thread created, plus anyone who `thread ask`ed (an ask
  only goes to the asker's creator). A removed worker's line is plain text, "Removed thread".
* **A message from this thread's creator counts as the user's**: it freezes the run, as the
  user's would. A lead made by another thread gets its tasks there, and without this its first
  turn (its creator's prompt) would never anchor a card.
* **Out of the card, as before**: turns started by another thread that is not a worker (another
  lead), and wakes that are no thread's (a pull request, a timer, an action run, a plugin, a
  restart notice). Such a turn keeps its note, header and gutter, sits among the stacked replies
  in order, and neither ends the run nor joins it. A batch counts as worker chatter only when
  every line in it is a worker's.
* **A user's steer inside a run turn makes that turn the user's**: it is drawn as before and
  freezes the card above it at the steer's time.
* **A worker's wake that lands mid-turn** is left out inside a run turn (its worker is in the
  card); inside the user's own turn it stays as a note, since that turn is drawn as before.
* **No card while the user's own turn still runs**: the card appears once that turn ended or a
  later turn exists, so the live turn's rows never stream above it.
* **A live run turn** shows its work as strips, with no note and no header; when it ends it
  folds to its reply like any turn. The pill above the composer says the lead works.
* **The fold toggle of a stacked reply is its gutter's steps count** ("› 3 steps", the header's
  chevron moved there; `GutterRow`, `fold` on the row). The steps are then not repeated in the
  gutter's info. A turn with nothing to fold has no toggle. Hover across the turn's rows works
  as before: `rowTurns` counts a run turn's rows from the row after the one before up to its
  gutter.
* **"Latest" gutter**: when the latest turn left nothing, the last gutter left is the latest,
  unless a turn still runs after it.
* **Line times** come from the timeline and the store, since no stream is opened for a worker:
  each worker's events (created, each wake, each message) are replayed. A frozen card's line is
  the replay just before the freeze; the current card's is the store's state now. A working
  line counts from `statusChangedAtMs`; a stopped one from the start of its last stretch to its
  stop. When a finished worker works again, the timeline does not say when the lead sent it
  more, so that stretch counts from its last stop (a slight overcount). The store also corrects
  the replay: a worker that is not live now and whose status changed before a time was not
  running at that time (a worker that settled without waking the lead). `statusChangedAtMs` is
  never used as an event: viewing a finished thread changes it.
* **The card's time when nothing runs** (the current card, all workers stopped) is its start to
  the last worker's stop, "Worked with N threads".
* **Keys**: the card is `w:<the anchoring turn's key>`, so it updates in place; a frozen card's
  fold choice is stored under that key with the turns' folds.

## The model is told, and "nothing for the user"

`internal/store/thread/waketext.go WakeReplyNote` ends every thread wake, batch, restart batch
and ask delivered to a thread that is not a resident (`deliverThreadWakes`, `queueAskLocked`),
and the sender line of a worker's message to its lead (`withWorkerReplyNote` after #819's
`fromNote`): the brief's words, with
one change in the last sentence (below). The orchestrate skill says it in one line
(`SKILL.md`, at its 9,700-byte budget, paid for by trimming two words) and in full in
`reference/wakes.md` ("What the user sees of a wake turn"), whose "end the turn silently" now
says `[nothing new]`.

**Claude Code cannot end a turn without visible text.** Checked on a dev daemon: told to end
after a tool call with no text, Haiku 5.5 wrote a line anyway; Sonnet 5.5 called the tool three
times and ended with no text, and Claude Code then sent it "[Your previous response had no
visible output. Please continue and produce a user-visible response.]", so it wrote one. The
smallest honest mark: the daemon tells the model to make its last message only
`[nothing new]` (`NothingNew`), and the GUI drops a run turn whose reply is only that
(`isNothingNew`: case, spaces, a full stop and backticks aside; `TimelineItem.quiet`, a
finished text only). Opened through its gutter (when it had work), the turn shows its work
without the marker. Outside a run (another lead's wake, the user's turn) the marker shows as
text. With the note, Haiku 5.5 answered a worker's ask whose assumption was right with exactly
`[nothing new]`; before it, it wrote "… so I didn't send a reply".

## Mock and tests

* Mock: `mock/workerCard.ts` (`POST /__mock/workers?state=live|needs|frozen`, `POST
  /__mock/workers/step`; `World.addWorkerCard`, `stepWorkerCard`; `MockThreadLogs.script`).
  s-wl-lead "Ship the three fixes" and its workers s-wl-1..3.
* `lib/workerRuns.test.ts`: no workers (same array), one worker, a batch of three, a report
  mid-turn (run turn and the user's turn), several rounds with a turn that leaves nothing,
  `[nothing new]` folded and opened, the user stepping in with carry-over, a frozen card's fold
  key, a finished worker not carried and then resumed, needs and asks, non-worker wakes and
  messages left alone, a worker's message and a removed worker, the creator's message, a user
  steer in a run turn, a live run turn and no card while the user's turn runs, `rowTurns`;
  `senderOf`, `workerNowOf`, `workersKey`, `isNothingNew`.
* `components/thread/WorkerCard.test.tsx`: lines (name, word, tone, time, mark, link or not),
  titles, the time with nothing running, frozen fold and open, the link's `openThread` call, the
  gutter's steps toggle.
* e2e `worker-card.spec.ts`: the live card updating (a worker finishes, a reply lands) keeps the
  same element and every row above it at the same place in the list; a frozen card folds and
  opens. SHOTS=<dir> also takes the PR's dark and light screenshots.
* Go: `TestWakeReplyNote`, `TestWithWorkerReplyNote` (a worker's message to its lead only),
  `TestAskWakesTheCreator`, `TestWakeBatchWindow` (single and batched), `TestResidentWakeNote`
  (a resident gets none).

## Gotchas

* The e2e mock's default ports were held by another worktree's run: `E2E_MOCK_PORT` and
  `E2E_VITE_PORT` move them.
* A wake's `created_by` is in a thread wake's payload only; an ask's has none, which is why an
  asker counts as a worker by kind.

## Verified

`make drive` against the mock (live, needs, frozen, the step) and a dev daemon on a scratch
home and project with Haiku 5.5: a lead started two workers with `--notify`; their real wakes
drew one card ("Worked with 2 threads", both finished) with the replies under it, and a
worker's ask answered with `[nothing new]` left nothing. The lines read "0s" there because the
asks and the message were sent from the CLI after those workers had finished (their last
stretch started at their stop), which a real worker does not do.
