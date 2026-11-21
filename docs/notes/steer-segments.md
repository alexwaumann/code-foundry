# Steer segments: a steered turn reads as "Worked for", the steer, "Continued for" (2026-11-20)

A message sent while a turn runs is a steer: Claude Code queues it, reads it at its next tool
call (or when the text it is writing ends), and the turn goes on to one turn end and one cost.
Before this change a folded steered turn read prompt, "Worked for 9m", the steer, the reply: it
said nothing about what happened before and after the steer. The steer bubble also moved when
Claude read it (the daemon placed it after the newest item that was not queued), and a message
Claude never read (its process ended first) lost its queued tag and looked read. A user asked
for the turn to split at the steer. The agreed design is the sketch
`opus-6-steer-inline.html`, V2 with "split at each steer", queued look dotted and dimmed,
caption "queued", the smaller steer bubble. Daemon (`internal/store/thread`), API, GUI
(`lib/threadTimeline.ts`, `components/thread/rows.tsx`, `UserBubble.tsx`), mock.

## What it looks like

* **Finished and folded**: prompt, "Worked for 3m 10s", the steer ("steered · +3m 10s ·
  14:15"), "Continued for 2m 41s", the next steer, ..., "Continued for 3m 17s", the reply, the
  gutter. Each header folds and unfolds only its own stretch of work, with the same component,
  chevron and hover as a turn's header. An interrupted or failed turn says so on the last
  header ("Interrupted after 3m 17s", red). The gutter starts with the whole turn's length:
  "9m 08s total · 14 steps · $0.62 · Opus 5.5 · 14:21", only for a split turn.
* **Running**: every stretch before the latest read steer has a settled header (open, folds
  when the user clicks it); only the stretch after it has the live header ("Working · 2 steps ·
  41s"), counting that stretch's steps and the time since Claude read the steer. The pill above
  the composer keeps the whole turn's time. While the turn runs no text folds (as before). While
  a permission or question blocks the turn there is no live header (as before); the settled
  stretches keep theirs.
* **At send**: the message is at once the live turn's last row, the smaller bubble with a
  dotted accent border and the bubble at 70% opacity, captioned "queued · 14:15" (the word's
  tooltip says when Claude reads it). Copy stays in the caption row. Anything that arrives while
  it waits is drawn above it.
* **At read**: it turns solid where it is, the caption becomes "steered · +3m 10s · 14:15",
  the header above settles into "Worked for 3m 10s", and a live header is appended under it.
* **Too late** (still queued when the turn ends): it waits under the finished turn's gutter,
  small and dotted, with no header. When Claude Code starts it as the next turn it becomes a
  full-size prompt in place (its top and right edge stay; it grows), caption just the time, the
  live header under it.
* **Never read**: dotted and dimmed, "not sent · 14:15" in the warning tone (tooltip "Claude
  stopped before it read this message"). It splits nothing.

## Decisions

### Daemon

* **`Item.ReadAt`**: set where `consume` clears `Queued` on Claude's `started` (or a
  `requesting` that lists it), to the same `now` as that update. Not `UpdatedAt`: later edits
  move it. Persisted as `read_at_ms` in `thread_items.data`.
* **`Item.Unsent`** replaces the silent clear: `consume(id, false)` (a `cancelled` lifecycle),
  `closeUnfinished` (crash, restart, archive, close, daemon stop) and a failed delivery after
  the handshake all mark it. A message the row still holds for the next process
  (`Setup.Queued`) stays queued, as before. Persisted as `unsent`.
* **An unsent message is placed like a read one** (`PlacedAfter` = the newest item that is not
  queued). The GUI drew it last while it waited, so this keeps it there; before, it went back
  to where it arrived.
* **Storage is additive**: two omitempty keys in the item's JSON. No migration, no rewrite. An
  old read message has no `read_at_ms`: it shows "steered · 14:15" and its turn is not split.
* **API**: `UserMessageItem.delivery` (`MessageDelivery`: UNSPECIFIED, QUEUED, READ, UNSENT) and
  `read_at`. `queued` stays for older clients. `thread read` prints ` (not sent)`.
* **Elsewhere**: a fork keeps `ReadAt` and `Unsent` (history) and marks a message still queued
  in the parent unsent in the copy. The fork cut's `conversational`, the wake's last-turn reader
  and the inline-page boundary treat an unsent message like a queued one (Claude never had it).

### GUI

* **One explicit state**: the view model's `delivery` ("queued" | "read" | "unsent") and
  `readAtMs`; `queued` is gone from the view. `TimelineItem` carries both in its structural key,
  so a read rebuilds the rows. This is where a follow-up's Cancel and Re-send hang: the caption
  row already has Copy then the state word.
* **Queued last** (`queuedLast`, in `buildTurns`): queued user items move to the end, in their
  order. The daemon places a message it read after the newest item that is not queued, which is
  the row it was drawn under, so a read is a style change in place. Verified on a real daemon
  (below).
* **Segments** (`segments`, `buildRows`): a turn that has a header splits at the steers that
  are the user's own (`from` empty), read, and have a read time. Steers by another thread, wakes,
  queued and unsent messages and read ones without a time stay inside their stretch as rows
  that never fold.
* **Keys**: the first header keeps `h:<turn>`, so the live header turns into "Worked for" in
  place; a later one is `h:<turn>:<steer id>`. Fold keys: the first stretch's is the turn's key
  (find bar, cite layer, a fork and the old choices keep working), a later one's
  `<turn>><steer id>`. `foldingTurn` returns the stretch's fold key, so the find bar opens the
  right stretch; the find store diffs fold keys, so it puts it back as before.
* **Default fold** is the turn's for every stretch: all fold at the turn end, none while it ends
  scrolled up (`deferred`), all on return. A settled stretch of a running turn folds only when
  the user clicks it.
* **Times**: the turn's start is the header's (its last opening message, or the setup's end
  when later: `useTurnStart`). "+3m 10s" and the first stretch are `readAt - start`; a middle
  one `next readAt - readAt`; the last one `turn_end arrival - readAt`, all on the daemon's
  clock. The gutter's total is Claude's `duration_ms` as before, so the stretches add up to it
  within Claude's start-up lag (a real 49s turn: 10s + 22s + 16s). Taking the last stretch from
  `duration_ms` instead read "Continued" with no time when a steer came near the end.
* **Waiting turn**: a turn whose opening messages are all queued (too late) has `waiting`: no
  header, not live, no lone live header, and the finished turn above stays the latest (its
  gutter shows at rest).
* **Unsent in `buildTurns`**: inside the open turn when there is one, else a row of its own
  (a note turn: no header). It is never a turn's "last work", so a message after a crash still
  starts a new turn.
* **Sizes**: a queued or unsent message uses the smaller bubble wherever it is (`.u.small`). The
  steer margin (`.u.steer`) is separate, so a too-late message keeps a prompt's margin and only
  its size changes when it starts.
* **Wake notes and From rows** keep their small tag: "queued", now also "not sent" (warning).
* **Workers' runs** (`lib/workerRuns`): a turn with a user steer is a user block, never a run
  turn, so a run turn is never split and `runRows` is unchanged. Segment headers carry the
  turn's key, so `splitBlocks` and `rowTurns` keep the whole turn one block (the gutter's hover
  spans all stretches).
* **No animation** on the queued look: it is a state.

### Mock

`send` while busy appends the message queued and reads it 600ms later (existing flows still
see their reply). `POST /__mock/thread/steer?do=hold` keeps steers queued; `do=read[&reply=0]`
reads them (with no reply the turn goes on as `/tool` and `/finish` script it); `do=drop` marks
them unsent, and `/thread/stop` does too. `/tool&done=1` adds a finished call. `finish` now
times the turn from its opening message, not the last message (a steer made it read "Worked
for 2.0s").

## Gotchas

* The real `thread read` showed a steer sent during a `sleep 8` read right after that call's
  result and already in place (no `PlacedAfter`); one sent while Claude wrote text moves, which
  is the case the queued-last drawing covers.
* A thread's live header lingers 2s after a stop (`activity.ts`): a screenshot of "not sent"
  waits for it.
* The mock's scripted streaming state keeps streaming its answer into the newest streaming text:
  a test that streams its own text after reading a steer gets that tail appended.
* Measuring "nothing moves" in a list pinned to the bottom: compare rows' tops inside the
  scroller's content (box + scrollTop), not on screen; the new live header scrolls the list.
  Find the scroller by its overflow style, not by "is overflowing" (that changes as it grows).
* The too-late window (Claude's last text to its result) and a send during a Haiku reply are a
  few milliseconds: not reachable by hand on a real thread. Covered by the Go table case "read
  after the turn's result: the next turn" and the mock e2e.

## Verified

* Go: `TestQueuedPlacement` (read times on every read case; cancelled is unsent and placed),
  `TestCloseUnfinishedMarksUnsent` (last item stays, written after moves under it, held stays
  queued), `TestForkKeepsPlacedOrder`, `TestItemsDBRoundTrip`, `TestSendWhileWorkingIsQueued`
  (archive leaves it unsent), API `TestUserMessageDelivery`, CLI `TestThreadReadQueued`.
* vitest: `lib/steerSegments.test.ts` (segments folded, open, two steers, live, queued last,
  old read, other sender, unsent, user fold while live, deferred, strips, keys, find bar,
  rowTurns, too late, unsent alone), `components/thread/steerRows.test.tsx` (header wording and
  lengths, interrupted, per-stretch fold, captions, live stretch, queued, not sent, too late),
  `queued.test.tsx`, `rows.test.tsx`, `UserBubbleCopy.test.tsx`.
* e2e `thread-steer-segments.spec.ts`: rows keep their places when a queued steer is read;
  folding one stretch leaves the others and the messages in place; too late becomes the prompt
  in place. SHOTS=<dir> takes the PR's screenshots.
* Mock (`make drive`): every state, dark and light.
* Real daemon (`make drive DAEMON=dev`, scratch repo and home, Haiku 5.5 medium): a steer sent
  during `sleep 8` was queued then read ("+10s"); a second one recorded queued at content
  top 635 and read at 635 with only a live header appended below; the finished turn read
  "Worked for 10s", "Continued for 22s", "Continued for 16s", gutter "49s total". Killing the
  claude process (SIGKILL by pid) with a steer queued: `(not sent)` in `thread read`, the
  dotted "not sent" bubble after the "Claude stopped unexpectedly" note, no split.
