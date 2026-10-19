# Queued messages: tagged until Claude reads them, then placed where it read them (2026-10-19)

From the orchestration battle test of 2026-10-19 (`/tmp/cf-exp2/results/REPORT.md` item
A8; E6 §4.1 and §3 "steering a busy child", E2 minor 7). A message or wake that arrived
while a thread worked was recorded where it arrived, but Claude Code only reads it at its
next tool call or once the reply it is writing ends. The reply under it did not answer
it ("Status?" above the previous message's answer), and the real answer came later. To
the user the agent looked as if it ignored them. Daemon transcript projection
(`internal/store/thread`), the API's paging, `thread read`, and the GUI's user rows.

## The signal

Probed with `claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages` on Claude Code 2.1.303 (Haiku 5.5), as the daemon runs it.
No `--replay-user-messages` needed:

* Every user message gets `command_lifecycle` frames keyed by its uuid, which is the
  item id: `queued` on arrival, `started` when Claude takes it into the conversation,
  `completed` at the end of the result that answered it, `cancelled` when dropped.
* Idle: `queued` and `started` 3 ms apart.
* Mid turn, during a tool call: `started` right after that call's `tool_result` (Q1 sent
  at 9.0 s during a `sleep 4`, started at 11.5 s, 4 ms after the result).
* During the final reply: `started` right after the reply's last text. Claude then
  answers it inside the same result: one `result` for both, no turn boundary. So "the
  next user-turn boundary" is not a usable fallback.
* At the reply's very end: a message sent between the last text and the `result` is
  `started` right after that result, a turn of its own. That result still says
  `queued_turn_count: 0`, so the count cannot tell whether anything is waiting.
* Interrupt: the `control_response` lists `still_queued` uuids, and those are started at
  once.
* The next `system/status` `requesting` lists the read messages in `user_message_uuids`
  (all of the turn's so far). This is a second signal.
* The JSONL transcript's `queue-operation` `enqueue`/`dequeue`/`remove` lines that E6 cited
  match `queued`/`started`. They are not needed: the stream says it first.

## Decisions

* **Queued at send**: `sendMessage` marks the item `Queued` when the stream status is busy
  or compacting at that moment (before this send counts). A send to an idle thread is
  never queued, so it does not flash. Messages held behind the handshake are marked when
  they are delivered behind the first prompt. This covers wakes and user sends the same way.
* **Consumed** (`queued.go`, `projector.queueEvent`) on `command_lifecycle started` or a
  `requesting` that lists it. The flag clears. If items were written while it waited, the
  item gets `PlacedAfter` = the highest ordinal of the items that are not themselves
  queued. It keeps its `Ordinal`, so `--since`/`--after` and `send`'s `#N` still name it.
  Two messages read together keep their arrival order.
* **No position, flag cleared** on `cancelled` and at the end of the process
  (`closeUnfinished`: crash, close, archive, daemon stop, lost run). Claude never read
  it, so it stays where it arrived.
* **No safety net at a turn end.** A first version cleared any flag still set at a
  `result` with `queued_turn_count` 0. The live check showed why that is wrong: a "Status?"
  sent as the reply ended lost its flag at that result. The later `started` then found
  nothing queued, and the message stayed above the reply it had not seen. A flag that
  gets no signal now waits for its process to end.
* **One order everywhere**: `itemOrder` sorts by `(PlacedAfter or Ordinal, placed,
  Ordinal)`. The daemon's log slice keeps that order (snapshots, `openTurn`, the wake
  engine's reads), and `newThreadLog` re-sorts rows loaded by ordinal. The GUI store
  sorts by the same key (`itemOrder` in `stores/thread.ts`), so a move is one
  `ItemUpdated`; no new event kind.
* **Persistence**: `queued` and `placed_after` live in `thread_items.data` (JSON). No
  migration.
* **Proto**: `ThreadItem.placed_after = 7` (any item, so a client can sort without
  knowing payloads), `UserMessageItem.queued = 7`.
* **Paging** (`thread read`, `ListItems` query): the page is in the log's order, but
  "the first/last N" and `nextSince` count by ordinal. Otherwise a placed message at the
  end of a page would hand out its lower ordinal as `nextSince`, and the next read would
  repeat items. Without `last`, nothing changes. `thread wait`'s default `after` (the
  latest message) is now the highest ordinal, not the last message in the log.
* **CLI**: `thread read`/`thread items` print ` (queued)` after a pending message or wake.
* **GUI**: `QueuedTag` is a small muted `queued` tag (`text-caption`, `rounded-sm`
  border) with the tooltip "Read by Claude at its next tool call". On a steer it sits
  after "sent mid-turn · 14:12". On a turn's opening bubble it sits after the time. On a
  wake note it sits before the age, on a batch's first line only. Once read, the tag
  goes and the row moves above the text that answers it.
* **Fork**: copied items are renumbered in the log's order, so `PlacedAfter` and `Queued`
  are dropped from the copy.

## Gotchas

* The message is still a steer inside the running turn, both while queued and after it is
  placed: a message read at the end of the reply is answered in the same result. Placing
  it after the previous text makes that text non-final, so when the turn folds only the
  answer to the steer stays visible. This is the existing steer behaviour.
* `thread wait --after <queued #N>` still counts any turn end, error or request with a
  higher ordinal as the reaction. A permission request written before the message was
  read still counts. Not changed (E6 §4.3 is its own item).
* Threads in this environment run under a harness hook that blocks a foreground `sleep`
  of about 20 s or more ("Blocked: standalone sleep 30"); Haiku then moved the step to the
  background. The live checks use `sleep 12`.

## Verified

* `make check` green. `queued_test.go` `TestQueuedPlacement` table: a message that
  arrives while Claude writes and is read at the next tool call; one that arrives during
  a tool call and is already in place; one read when the final reply ends (same turn); a
  wake; one read after the turn's result (as probed); two read together; the requesting
  signal; an idle send that is never queued; cancelled; no signal yet. Each case also
  checks that a reloaded log has the same order.
* `TestSendWhileWorkingIsQueued` (store plus fake claude): a send while a permission is
  pending is queued, the first prompt is not, and archiving clears the flag.
* Also `TestCloseUnfinishedUnqueues`, `TestForkKeepsPlacedOrder`, a round trip in
  `TestItemsDBRoundTrip`, API `TestPageItemsPlaced` (paging and `lastMessage`), CLI
  `TestThreadReadQueued`, and GUI `queued.test.tsx` (order, the move on an update, the
  tag, a wake's tag).
* Live, isolated daemon, a Haiku 5.5 medium thread in a scratch repo running four steps
  (`sleep 12`, `ls`, `sleep 12`, a commit listing), with two `thread send` calls during
  the turn. While they waited, `thread read` showed:

```
#2 tool Bash [running] {"command":"sleep 12",...}
#3 you: Q1: what is 2+2? (queued)
...
#6 tool Bash [done] {"command":"ls",...}
#7 you: Q2: what is the capital of France? (queued)
#8 claude: The directory listing came back empty, ...
#9 tool Bash [running] {"command":"sleep 12",...}
```

  Once read:

```
#3 you: Q1: what is 2+2?
#4 thinking
#5 claude: The first wait finished with no output. Answer to your question: 2 + 2 = 4.
#6 tool Bash [done] {"command":"ls",...}
#8 claude: The directory listing came back empty, ...
#9 tool Bash [done] {"command":"sleep 12",...}
#7 you: Q2: what is the capital of France?
#10 thinking
#11 claude: The capital of France is Paris. The second wait finished with no output.
```

  Q1 came during a tool call, so it kept its place and only lost the tag. Q2 came while
  Claude was still writing #8 and starting #9, so it moved after #9, right above its
  answer. A run with the GUI open (the PR's screenshots) did the same: the message moved
  from above the turn's thinking and first `sleep 12` to just after them.
