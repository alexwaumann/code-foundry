# Other threads: one line each on the sending side, a From row on the receiving side

Two lead threads that talk to each other (neither a worker of the other) exchange short
one-offs. Before this, the sender's record was a plain note line per message ("Told … · no
reply needed", `thread-reply-mark.md`) and every message from the other thread was a full
user bubble that read like the user's own. The agreed design (turn sketch 8 section 2, sketch
7 sections 2 and 3; the brief where they differ) draws them like a worker run (`worker-card.md`)
but with a line per thread instead of a card.

## What was agreed

* **Sending side: one line per other thread per run**, changing in place: a dot, the other
  thread's name (bold; it takes the width, a tooltip only when cut), what happened in a few
  words, and the time at the right. It opens that thread (`openThread(id, { from })`, as a
  worker card's line). Nothing expands. No "not yours" tag: the line form is the distinction.
* Two other threads are two lines; when the thread also has workers, the card comes first and
  the lines sit under it.
* **Replies stack under the line(s)** as under a card: the other thread's messages inside the
  exchange are not drawn, the turns they start have no header and leave only their reply (none
  for `[nothing new]`).
* **The user's next message freezes the lines**: past form, the freeze time at the right
  (`sentTime`, as message times). Frozen lines do not fold. A conversation that resumes after
  the user's message gets a new line in the new run.
* **Receiving side: a From row** where the bubble would be, for a message from a thread that is
  neither this thread's lead nor its worker: "From <name>", "wants a reply" in the warning tone
  when the sender waits for an answer, the message's first line, the time. The turn after it is
  a normal turn; this thread's answer is a line under that turn ("answered").

## The words (`lib/peerLines.ts peerWords`)

The head is this thread's first message to the other thread in the run, in the daemon's
note vocabulary (`internal/store/thread/replies.go sentText`):

| Head | When |
|---|---|
| `told · no reply needed` | no reply wanted (dot: info) |
| `asked · waiting for a reply` | wanted, none yet, current run (warning) |
| `replied` | its answer came in the run (success); also a line that starts with the answer to a question from an earlier run |
| `asked · no answer yet` | the other thread ended its turn without one, or (frozen) none had come by the freeze (muted) |
| `asked · no answer: archived` / `removed` | as the note (muted) |
| `answered` | it answered a question the other thread asked first (success) |

Then, after ` · `, in the order they began:

* `then asked 1 question` / `N questions`, plus `, answered` once this thread answered them all
  (the other thread asked; the sketch's words);
* `then sent 1 message` / `N messages`: the other thread told it something with no reply
  wanted (found while driving the mock: a follow-up inside an exchange is folded into the line,
  so the words must say it came);
* `then asked it 1 question` plus `, replied`, ` · waiting for a reply` or `, no answer yet`
  (this thread asked again).

The time at the right while the line is current is how long since the exchange began (the
first message either way), ticking, in the sidebar's units (`formatDuration`,
`statusTimeUnits`); that is what the sketches drew ("1m" just sent, "26m" later, a told line
included). Frozen: the freeze time.

## Decisions made here

* **One grouping**: #826's `workerRuns` pass now also builds the lines (`exchanges`), so a run
  holds worker turns and other-thread turns together; a turn opened only by worker wakes and
  messages inside an exchange is a run turn. A thread with no workers and no sent note gets
  the very same rows back.
* **When a message is inside an exchange**: the thread sent the other thread something earlier
  in the run, or the message is the answer to one of its questions (the note's
  `reply_item_id`, from any run). Otherwise it is a From row and opens a turn of its own, which
  is no run turn. A message from this thread's creator still counts as the user's, and a
  worker's is the card's.
* **Where a line goes**: under the turn that first sent to that thread, once that turn ended
  (or something came after it), as the card waits for the user's turn to end; a line that
  starts with an answer from an earlier run goes above the turn that answer opened. With a
  card at the same place, the card first.
* **Keys**: `p:<the run's anchoring turn key>:<thread>`, so a line's words change in place;
  e2e checks that the answer arriving moves no row above it and keeps the element.
* **Data**: the sent note's record rides on the timeline's structural key as one string
  (`TimelineItem.sent`, `<to>/<w|n>/<state>/<reply item>`, `sentDescOf`), only for relation
  `other` (a message to its lead stays a plain note). The sender descriptor of a thread's
  message gained its mark (`m:<id>/w`). The note's in-place update changes the key, which
  rebuilds the rows once.
* **From row**: decided by the item's own relation (`from.relation === "other"`), the daemon's
  at send time, for an opening message and a steer alike; the grouping only hides the ones
  inside an exchange. **Expansion in place** under the line (the row's expanded state, like a
  tool row), not the wake note's code block: a message is prose, and its text there is plain
  and selectable. The name is a link to the thread; the rest of the line toggles.
* **Prompt rail**: a From row is in it, since it opens a turn: a shorter tick (4px against
  8px) and "From <name>" above the preview in its tooltip and accessible name. Messages hidden
  inside an exchange are not (they have no row).
* **Find**: a match in a From row's message opens it (`openThreadFindItem` sets its expanded
  state, put back with the rest when the match moves on). A message hidden inside an exchange
  has no row, as a worker's message inside a card (#826): its match counts but cannot be shown.
  Citations only quote Claude's text, which the lines never hide.

## Mock and tests

* Mock: `mock/peerLines.ts`, `POST /__mock/peers?state=waiting|replied|asked-back|workers|frozen`
  (s-pl-a "Ship the release" the sender, s-pl-b "PR page redesign" the receiver, s-pl-c, and in
  `workers` the worker s-pl-w) and `POST /__mock/peers/step` (B answers now, the note updates in
  place: `MockThreadLogs.patch`).
* `lib/peerLines.test.ts`: the grouping (told; asked; replied; asked back, then told; asked back
  open; two threads; with a worker card; the user stepping in and a new line; an answer after
  the freeze; the receiving side; no line while the sending turn runs; creator's and worker's
  messages unaffected; a receiver that sent nothing keeps its rows), the key held across an
  update, `rowTurns`; `peerWords` per state live and frozen; `sentDescOf`/`decodeSent`.
* `components/thread/PeerLine.test.tsx`: the line (tone, name, words, time, link, removed
  thread, frozen time), `peerTime`, the From row with and without the tag, expansion by click
  and Enter, the name's link, find opening it, a lead's message staying a bubble.
  `PromptRail.test.tsx`: a From row's tick.
* e2e `thread-peer-lines.spec.ts`: the answer arriving changes the line in place and moves no
  row above it. SHOTS=<dir> takes the PR's screenshots.

## Verified

`make drive` against the mock, both threads, every state and the step. Then a dev daemon on a
scratch home and project, two Haiku 5.5 lead threads: the Release lead, told by the user to let
the Docs lead know something, sent `--reply none` (line "told · no reply needed"); asked to find
something out, sent `--reply wanted` and ended its turn; the Docs lead's answer woke it (line
"replied", its reply stacked under it with no header). The Docs lead showed both messages as
From rows (the second with "wants a reply") and its answer as an "answered" line under that
turn. The daemon was stopped; the scratch home, project and its Claude transcripts were deleted.

## Gotchas

* The mock daemon does not reload on edits: restart `make drive` after changing `mock/*`.
* Removing a mock thread needs the list's `removedId` event, or the GUI keeps it.
