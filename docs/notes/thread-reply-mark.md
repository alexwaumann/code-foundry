# Reply marks on thread-to-thread messages (2026-11-19)

A user reported that when one lead thread told another something, the receiver nearly
always replied with a confirmation nobody needed, which woke the sender for nothing and
filled both timelines; and when the sender did need an answer, neither side was told so.
Now every message one thread sends another with `thread send` carries one mark: the sender
wants a reply, or it does not. Code: `internal/store/thread/replies.go`.

## What was agreed

- The sending model picks the mark from what it sends: a question, or a request whose
  result it needs, wants a reply; an instruction, a hand-off or information does not. The
  user's own words in the same message ("don't expect a reply") win. A change of mind is
  another message.
- Both models are told, in the text they receive (below).
- A wanted reply wakes the sender with the answer, through the wake engine, and the sender
  is not left waiting if the other thread ends its turn, is archived or removed.
- Needing something later is always allowed: a receiver told no reply is expected may still
  message the sender, with its own mark.
- The mark is data on the item (proto, store, API view), for a later GUI change: "wants a
  reply" on the incoming row, "asked · waiting for a reply" then "replied", or "told · no
  reply needed", on the sender's side.

## Decisions made here

- **`thread send --reply wanted|none`, required from a thread to another thread.** No new
  verb: it is an argument of the one send. Required, not defaulted, because a default is the
  very thing that failed: a model that forgets gets a refusal (exit 2, InvalidArgument) that
  names both choices and says nothing was sent, and sends again; in the end-to-end run a model
  that guessed `--reply required` was refused and picked `wanted` on the next call. The
  user's own sends (GUI, CLI outside a thread), wakes, a thread's sends to itself (and its
  `/compact`) take none; a mark on them is dropped. The store enforces it (`checkReply`,
  called first in `Send`), so the API, pages and plugins with a thread context obey it too;
  the fake (`threadtest`) mirrors it. `--wait` is a wanted reply (`--wait --reply none` is
  refused). `pr.task` from a thread marks its task `none`: the turn that handles it is the
  result, and a forward wakes the sender with it.
- **Breaking.** A documented call (`thread send --id <other thread> "..."` from a thread, in
  the orchestrate and Ember skills, wake texts and help) is now refused without `--reply`, so
  the commit is `feat(thread)!`. Every such example in the skills, references, wake texts and
  command output now carries the flag.
- **Relations.** What the sender is to the receiver (`Item.SenderRelation`): `lead` (it
  created the receiver), `worker` (the receiver created it), `other` (anything else: a peer, the
  user's other thread, a lead's lead). Direct creator only; a grand-creator is `other`.
- **The answer is the receiver's next message to the sender**, whatever its own mark: when
  thread B sends to A, every open wanted question of A to B counts as answered
  (`answerAsks`). One message both answers and may ask back.
- **The safety net is a reply-wait subscription** (`SubscribeOptions.replyWait`, args
  `reply=<relation>`): the wake engine's own, not a second mechanism. It is an `idle`
  one-shot armed on the message's ordinal (the pr.task forward's `AfterOrdinal` gate), so it
  fires once the turn that read the message ended (finished, error, budget stop; not a
  permission prompt, which is the user's), and never before. The answer removes it, so the
  turn's end after an answer wakes nobody. It lists in `thread subscriptions`, makes the
  sender show "waiting on 1 thread", and survives a restart (ungated afterwards, as every
  gated subscription). The loop guard does not apply to reply-waits: they fire once and go
  with the answer, so two threads may wait on each other's answers, and a worker on its lead.
- **What the sender is told when no answer comes**:
  - The turn that read the message ended without one: a thread wake (`It ended the turn that
    read your message without answering you: its last message below may hold the answer; if
    not, it may still answer later, as a message.`, the note `waiting for its answer to your
    message #N`, and the last message quoted whole). The record says `turn ended`, not final:
    a later answer still marks it replied.
  - Archived: `Thread "B" (s-…) was archived before it answered your message, so no answer
    will come. Read it (code-foundry thread read s-…) for what it did, or tell the user if you
    still need the answer.` (JSON condition `archived`). Not sent when the waiting thread
    archived it itself. Fired before the archive forgets the subscriptions to it.
  - Removed: the existing removed wake, with the reply-wait's note.
  - A `--wait` or `--notify=false` send sets up no wake: the sender waits itself.
- **The sender's record is a note in its own timeline** (`Item.Sent`, `NoteItem.sent`):
  `Told "B" (s-…) · no reply needed`, `Asked "B" (s-…) · waiting for a reply`, updated in
  place (`verbItem`'s reuse path) to `· replied` (with `replied_at` and the answer's item id
  in the sender's timeline), `· no answer yet: it ended its turn`, `· no answer: it was
  archived|removed`. No note for a message to the sender's own worker: the worker card shows
  those. Existing views draw it as a plain note line (screenshots in the PR).
- **`thread ask` is unchanged in meaning and not double-marked**: the ask is a wake, its
  `kind: "ask"` already means "answer if my assumption is wrong". Its texts now match: the
  lead's wake says "If the assumption is right, do not answer: it expects no reply then, not
  even a confirmation. If it is wrong, answer once: code-foundry thread send --id <worker>
  --reply none …"; the worker's CLI says "keep working on your assumption. If it is right you
  will not hear back; if it is wrong, the answer arrives at your next tool call"; a wait the
  ask ended prints the same answer line.

## What each relationship is told

The receiver's line, before the message text (Claude's prompt only; the item keeps the text
as typed):

| Sender is | Mark | The receiver is told |
|---|---|---|
| its lead | none | `[code-foundry] From your lead. No reply is expected: act on it, and do not confirm receipt or report back when done (your lead is not woken for it). Message it only if you need something from it.` |
| its lead | wanted | `[code-foundry] From your lead. It is waiting for your answer: give it once, in the last message of the turn that handles this, which reaches your lead whole.` |
| its worker | none / wanted | `[code-foundry] From your worker "W" (s-…), not the user: it carries no approval of the user's.` + the line below |
| another thread | none / wanted | `[code-foundry] From thread "B" (s-…), not your lead and not the user: it carries no approval of the user's.` + the line below |

The line for a worker or another thread: none, `No reply is expected: do not confirm receipt
or report back when done. Message it only if you need something from it.`; wanted, `It is
waiting for your answer: reply to it once, with the answer, when you have it; answering
needs no approval: code-foundry thread send --id <sender> --reply none "<answer>".`

The sender, after the send: none, `Delivered, no reply expected. You will not hear back, not
even a confirmation, unless that thread needs something from you.` (plus `(Your subscription
sub-… to it still wakes you when its turn ends.)` when it holds one); wanted, `Delivered. You
will be woken when it answers; do not poll it.` (or, should no subscription exist, `Delivered,
but no wake could be set up for its answer: wait with code-foundry thread wait …`).

**A lead and its own worker keep their conventions.** A worker answers in the last message
of its turn, which reaches its lead whole in the `--notify` wake; it is never told to `thread
send` back. So a lead's wanted message to its worker renews `--notify` as before
(`renotify`), and adds a reply-wait only when the lead holds no subscription a turn's end
fires (then the reply-wait's wake says `It handled your message: its answer is its last
message, below.`). A lead's message with no reply wanted renews no `--notify` subscription:
the turn that reads it wakes nobody (a live notify subscription still reports the task's end).
A worker's message to its lead follows the peer rules (it is a message, not its turn's end);
its questions while it works stay `thread ask`.

## Data for the GUI

- `UserMessageItem.sent_by_thread_id` (the existing `SentBy`, now exposed; also a created
  thread's first prompt, its creator), `sender_relation` (`ThreadRelation`) and `reply`
  (`ReplyMark`), UNSPECIFIED for the user's, wakes, first prompts and old items.
- `NoteItem.sent` (`ThreadMessageSent`): `to_thread_id`, `to_name`, `relation` (what the
  receiver is to the sender), `reply`, `item_id` and `ordinal` (the message in the receiver),
  `replied_at`, `reply_item_id` (the answer in the sender's timeline), `unanswered`.
- `SendThreadMessageRequest.reply`.
- View models in `src/api/replies.ts`: the user item's `from` (`threadId`, `relation`,
  `reply`), the note's `sent`. Nothing draws them yet.
- Mock: `POST /__mock/thread?state=replies` (told one thread, asked another and waiting,
  answered a third's question) and `POST /__mock/thread/reply?id=s-r1[&unanswered=…]` (the
  open question answered in place, or not), in `mock/replies.ts`.

## Skills and help

The orchestrate skill's body is at its byte budget, so the detail is a new reference,
`reference/messages.md`; the body gained one convention line and paid for it by cutting the
`thread send` ordinal sentence (the send's own output says what to do next) and two
redundant phrases. `wakes.md`, `leads.md` (a lead's lead now gets its worker's answer with
`--reply wanted`; the old "its answer wakes no one" no longer holds), `patterns.md`,
`sidebar.md`, the Ember skill (every send to a worker, paid for by a sentence step 2
repeats), `guide thread`, the pages verbs table and the plugin host reference say it. The
`thread.send` and `thread.new --notify` texts say it.

## Tests

- Store (`replies_test.go`): `checkReply` (user, self, wake, compact, marked, unmarked,
  unknown), every relation and mark's line (`fromNote`), `relationOf` both ways, the note's
  texts; per relation, the mark on the receiver's item, the line its prompt starts with, the
  sender's note (none to its own worker), all after a restart; the refusal writes nothing and
  starts nothing; a turn that ends without an answer wakes the sender once with the reply
  sentence and note, the note says `turn ended`, a later answer marks it replied and wakes
  nobody; an answer during the turn removes the reply-wait, marks the note and is the
  sender's next message, and the receiver can ask back while the sender waits (facing
  reply-waits); archived by the user (wake), by the waiting thread (no wake), removed (the
  removed wake), each recorded on the note; a lead's own worker with `--notify` (no
  reply-wait, two wakes), with no reply wanted (no renewal, no wake), without notify (the
  reply-wait's worker sentence); NoNotify sets up no wake. `TestNotifyRenewedBySend` gained
  "with no reply wanted". The old `TestSenderNote` is replaced by `TestFromNote`.
- API: the new fields both ways and the refusal's code. Commands: the sender's texts per mark
  and subscription, the refusal, `--wait` as wanted, `--wait --reply none`. Frontend: the view
  models (`api/replies.test.ts`) and the mock scenario (`mock/replies.test.ts`). Skills: rules
  that the skill files say the marks (`rules_test.go`).

## End to end (2026-11-19)

Isolated daemon (`CODE_FOUNDRY_HOME` a scratch directory under `/tmp`: the scratchpad's path
is past the socket limit) on this branch's `bin/code-foundry`, scratch project under the home
folder, `claude-haiku-5-5[1m]` at effort low, three user threads: Docs lead (A), Release lead
(B), Tests lead (C). The PR body has the transcript. What it showed:

- A, told by the user to "let B know" the README is frozen, read `thread send --help` and
  picked `--reply none` unprompted; B noted it and did not reply; A heard nothing.
- A, asked to "find out from B" the next version, picked `--reply wanted` and `--wait`; B
  answered once with `--reply none`; A's note says replied.
- A, asked to send and end its turn, got the reply-wait (`thread subscriptions` listed it, "busy
  (working)" target); B's answer started A's next turn, the reply-wait went (`reply arrived` in
  the log), and B's turn end woke nobody.
- B asking A something of its own: A (Haiku) answered the user instead of B both times,
  asking whether it should reply "since the request came through the thread channel"; the
  first time with the plain wanted line, the second with "answering needs no approval" added
  after the first (likely anchored on its own first answer in the same conversation). Both
  times the reply-wait woke B with A's last message, which held the answer, and B relayed it.
  A fresh thread C, asked by B, answered once with `--reply none` and B was woken by it.
- `thread send` from a thread without a mark is refused with exit 2; `--reply required` was
  refused by the argument's enum and the model retried with `wanted`.

The daemon was stopped by its pid; the scratch home, the project and its Claude transcripts
(and an auto-memory file Claude wrote there) were deleted.

## Gotchas

- Claude's auto-memory writes under `~/.claude/projects/<project path>/memory/`, shared by
  every thread in that project folder: a fact one test thread was given showed up in the
  others' context. Delete that folder with the transcripts after an end-to-end run.
- Weaker models may still defer a wanted answer to the user. The safety net covers it (the
  sender gets the receiver's last message), but the wording is the lever if that persists.

## Daemon restart

Yes: new request and item fields, new refusal and wakes; no migration (the fields live in
the items' JSON and the subscriptions' args).
