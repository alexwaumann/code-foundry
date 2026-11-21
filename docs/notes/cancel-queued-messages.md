# Cancel a queued message; Re-send or Cancel a not sent one; Interrupt holds (2026-11-20)

A user asked for an easy way to take back a message while Claude has it queued, and, when a
message did not send (an interrupt, a crash), for both Cancel and Re-send on it. Builds on
steer-segments.md (#889: `Queued`, `ReadAt`, `Unsent`, the `delivery` enum). Daemon
(`internal/store/thread/cancel.go`), claudestream (`Conn.CancelAsyncMessage`), API
(`ThreadService.CancelMessage`, `ResendMessage`), commands (`thread.message.cancel`,
`thread.message.resend`), GUI (`components/thread/MessageActions.tsx`, `stores/threadActions.ts`),
mock.

**Behaviour change: Interrupt now stops.** Before, Claude Code started whatever was still
queued as a new turn the moment it was interrupted. Now the daemon first takes the user's own
queued messages out of Claude's queue; they become "not sent" where they are, with Re-send and
Cancel, and nothing starts.

## The protocol (probed on Claude Code 2.1.284, 2.1.294 and 2.1.325: all the same)

Captures: `internal/claudestream/testdata/{cancel-queued,cancel-late,cancel-first-of-two,
cancel-then-interrupt,interrupt-queued}.wire.jsonl` (2.1.284, both directions, trimmed: no
initialize payload, no init frame details, hooks, deltas, rate limits or task frames).

* Request: `{"type":"control_request","request_id":"…","request":{"subtype":
  "cancel_async_message","message_uuid":"<the user message's uuid>"}}`. Our item id is that uuid.
* While queued: Claude writes `command_lifecycle` `state:"cancelled"` for it, then answers
  `{"cancelled":true}`. It is never `started`; the model never sees it.
* Once read (`started`): `{"cancelled":false}`; it runs and gets `completed`. Trust the answer,
  not the timing of the frames.
* Interrupt with a message queued: `{"still_queued":["<uuid>"]}`, and that message starts at
  once as a new turn. Cancel each queued uuid first, then interrupt: `{"cancelled":true}`, then
  `{"still_queued":[]}`, one result (error_during_execution, aborted), nothing after.
* Two queued, the first cancelled: the second is still read in order.
* An interrupted turn's own prompt gets a `cancelled` lifecycle too (not `completed`).
  `consume` only acts on an item that is `Queued`, and the prompt was read, so it changes
  nothing: the prompt is not marked not sent (Go case "cancel-then-interrupt (held by the
  interrupt)" checks it).
* 2.1.284 is the oldest version that must work. The interrupt option `cancel_queued:true`
  (capability `interrupt_cancel_queued_v1`) is not used: untested; cancel-each-then-interrupt
  was probed.

## Decisions

### Daemon

* **`Item.Cancelled`** (persisted as `cancelled` in `thread_items.data`, omitempty; additive, no
  migration): the user took it back (Cancel) or sent it again (Re-send). The item leaves the
  in-memory log at once (`takeBack`), its row is rewritten saying so, and `loadItems` never
  loads it again. So no snapshot, page, `thread read`, fork, last-turn reader, handled count or
  html boundary has it; nothing that #889 taught about Unsent needed a second rule. Search: its
  document is dropped (`userSearchText` is "" for it). Prompt history (`scanPrompts`, which
  reads rows) skips it. Only the one `ItemUpdated` that removes it carries it (API delivery
  `MESSAGE_DELIVERY_CANCELLED`), so watchers drop it.
* **Cancel of a queued message**: the daemon claims the item (`claimTakeBack`), then asks
  Claude. The `cancelled` lifecycle arrives before the answer on 2.1.284; with the claim,
  `consume` takes it back instead of marking it unsent. `{"cancelled":true}` takes it back if
  the frame has not; `false` is refused as "already read by Claude" (FAILED_PRECONDITION) and
  nothing changes. A message still on a setup's row (`Setup.Queued`, no process yet) comes off
  the row instead; past spawn's commit it is refused with "try again in a moment".
* **Cancel of a not sent one**: no request, it just goes.
* **Re-send**: only a not sent message. It goes through `Send` like any message (a stopped
  thread starts, a working one queues it), then the old one is taken back. An attachment no
  longer staged is left out of what Claude gets but kept on the new item (`shownAttachments`):
  the bubble draws it dashed with "no longer staged", the way it marks any gone attachment, and
  the CLI and a GUI notice name it.
* **Who may be taken back**: the user's own top-level messages only (`userOwn`: `Origin` user,
  no `SentBy`, no parent tool use). A wake or another thread's message is refused, as are an
  unknown id (NOT_FOUND), one Claude read, one cancelled already, and any on an archived thread
  ("unarchive it").
* **Interrupt holds** (`holdUserQueued`, before the interrupt request): for every queued message
  that is the user's own and not on the setup's row, `cancel_async_message`; each `true` makes it
  Unsent where it is (`consume(id, false)`; its lifecycle does the same). A `false` (just read)
  or an error is logged and the interrupt goes ahead. Wakes and other threads' messages are
  left in the queue: Claude starts them at once, as before (a lead that sends then interrupts
  still redirects its worker). Per caller:
  * `Manager.Interrupt` (GUI button, CLI, another thread's `thread interrupt`): holds.
  * `Respond` with a deny that stops the turn (`Interrupt` on the decision): holds; it stops
    like Interrupt.
  * The budget stop: holds (otherwise the held turn would spend past the budget).
  * The user's Restart (`interruptForRestart`): holds. The old process would start them and the
    restart would wait for that turn or cut it off; held, the user re-sends to the new process.
  * Closing a busy thread (archive, close, remove): holds, so a queued message does not start
    on the way out; it ends Unsent as before (closeUnfinished).
  * Effort, project-set and move restarts never interrupt (they wait for the prompt), and
    `Setup.Queued` messages are not in Claude's queue: unchanged.
* **Concurrency**: the control requests run outside the runner goroutine, like Interrupt's;
  `consume` and `takeBack` take the log's lock and check the item's state, so the frame and the
  answer can come in either order. `claimTakeBack` refuses a second Cancel or Re-send of the
  same message while one is on its way.
* **Edge left**: a message sent while Claude starts, before the handshake, is in no queue yet;
  a Cancel then gets `false` and is refused as already read, and the message goes out. The
  window is the handshake.

### API and CLI

* `CancelMessage(thread_id, item_id) → item` (delivery CANCELLED, with its text, composer text
  and attachments), `ResendMessage(thread_id, item_id) → item, gone_attachments`.
  `MESSAGE_DELIVERY_CANCELLED = 4`. All additive.
* `code-foundry thread message cancel|resend --id <thread> <message>`: the message is `#N` as
  `thread read` prints it, or the item id. Cancel prints the text it took back. Both are
  `NoPalette` (a bubble's own control) and `NoIndex` (an agent's messages are another
  thread's, so it never needs them; the agent guide does not list them). Page class: drives.

### GUI

* **Controls** (`MessageActions`): plain text buttons in the caption row, always shown while
  they apply (not on hover), at the row's left right before the caption: queued has
  `Cancel`; not sent has `Re-send` and `Cancel`. No tooltip (the word is the name). Only on the
  user's own message in a timeline (`messageId`: no `from`, no parent tool use). 22px tall,
  like Copy, so the row's height does not change when they go; at the left, so the caption
  keeps its place when Claude reads the message (e2e checks both).
* **Cancel puts the message back** through the failed notice's Edit path (`editThreadMessage`):
  tags as typed (composer text), attachments read back and attached again (a gone one left out
  with the existing notice), citations as draft tokens. **Draft collision**: that path's rule,
  kept: the cancelled text goes after the draft, a blank line between. Then the prompt is
  focused, caret at the end (`focusCiteTarget`). Done only after the daemon said it was taken
  back.
* **Already read**: no error toast; an info notice "Claude already read your message", and the
  bubble turns into the read steer by itself. Other failures toast as usual.
* **Removal**: `toThreadEventView` maps an update saying CANCELLED to a `removed` event; the
  log drops the item from `byId` and `order`. Snapshots never contain one. No view model
  carries "cancelled".
* **The failed-prompt notice**: kept for what it was built for (the last prompt whose turn
  failed without a reply). It now passes over a not sent message instead of judging it, so a
  not sent steer is handled by its bubble's controls only; the notice can still be about the
  prompt before it when that one got no reply (a different message).

### Mock

`thread.message.cancel` and `thread.message.resend` like the daemon's (refusals included);
`thread.interrupt` marks the queued steers not sent before it ends the turn;
`POST /__mock/thread/steer?do=late` makes the next Cancel of a queued steer find it read.

## Gotchas

* **No Copy while the controls show.** The copy icon is laid out while hidden (opacity), which
  left a 24px gap between the controls and the caption until the bubble was hovered; a user
  disliked the gap. A queued or not sent message has no Copy: Cancel hands its text back to
  the composer, and Copy comes back once Claude read it. The caption is at the row's right
  edge, so it does not move when Copy takes the controls' place.
* A unit test that mocks `@/api/threads` narrowly breaks once a component imports
  `stores/threadActions` (it needs more of that module): spread `importOriginal`.
* `palette.test.ts` and the Go registry lists (`palette_test.go`, `keybindings_test.go`,
  `index_test.go`, `page_class_test.go`, `commands_test.go`, mock `NO_KEYBINDING`) all name
  every new verb.

## Verified

* Go: `TestConnCancelAsyncMessage`, `TestCancelLifecycleFrames` (claudestream, captures);
  `TestCancelCaptured` (the five captures through the projection: user cancel, too late, first
  of two, cancel then interrupt, held by the interrupt, and the old interrupt starting it),
  `TestCancelQueuedMessage` (fake claude: gone, row says cancelled, not loaded, not in prompt
  history, second cancel refused; late answer refused and still queued),
  `TestInterruptHoldsUserQueued` (cancel before interrupt on the wire, only the user's message,
  wake and lead message left queued, every refusal, Re-send, Cancel of a not sent one, archived),
  `TestResendGoneAttachment`, API `TestUserMessageDelivery`, CLI `TestThreadMessageCommands`.
* vitest: `MessageActions.test.tsx`, `stores/cancelMessage.test.ts` (args, composer text back
  after the draft, tags, already read, double press, Re-send, gone attachments),
  `api/cancelledMessage.test.ts`, `failedPrompt.test.ts` (not sent passed over).
* e2e `thread-cancel-message.spec.ts`: the caption row keeps its height and the caption its
  place when Cancel goes at the read; after Cancel the keyboard is in the prompt with the text
  after the draft. `thread-steer-segments.spec.ts` still green. SHOTS=<dir> takes the PR's
  screenshots.
* Mock (`make drive`): queued with Cancel, Cancel with a draft (text after it, focused),
  Interrupt holding a steer, Re-send, dark and light.
* Real daemon (`make drive DAEMON=dev`, scratch repo and home, Opus 5.5 [1m] medium, Claude Code
  2.1.325): a steer cancelled during `sleep 12` was gone, and when asked to repeat every message
  it was told Claude listed the prompt, a later read steer and the question, not the cancelled
  one; a steer already read was refused ("already read by Claude"); Interrupt from the GUI with
  a steer queued left it "not sent", the thread idle, no new turn; Re-send from its bubble ran it
  as a new turn; SIGKILL of the claude process (by pid) with two steers queued left both not
  sent, then Cancel of one and Re-send of the other (which started Claude again) from the CLI.
* Claude Code 2.1.284 (the floor; `advanced.claude_path` on the scratch daemon): a queued steer
  cancelled, a second one queued then Interrupt: not sent, idle, nothing started; asked to repeat
  every message, Claude listed only the prompt and the question.
