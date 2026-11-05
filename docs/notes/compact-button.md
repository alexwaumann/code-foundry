# Compact button

Past 400K tokens of context, with Claude at its prompt, a thread offers to compact in two places:
a chip in the composer's left row and a row under Context in the thread info card. Both run
`thread.compact`, which sends `/compact`.

## Decisions

* **One rule, in `lib/compact.ts`.** `compactOffer` returns the tokens to show or null. The
  threshold is fixed for every model (`contextTokens > 400_000`, strictly) and GUI only: the
  command has no threshold.
* **Shown:** idle, stopped (the command starts Claude), a finished turn not seen yet, a failed
  turn, a process that died. **Hidden:** working, compacting, starting, an effort restart, a
  pending permission or question, an unfinished setup, a deleted transcript. The chip also hides
  while a message is on its way.
* **Not on Ember's or a plugin's thread.** Their composers are the same component, so the rule
  reads `resident` and `owner`. The subagent view has its own composer and its own context
  group (`SubagentComposer`, `RunContextGroup`), so neither control reaches it.
* **`ThreadService.Compact`, not `thread.send` with a check in the command.** The refusal has to
  be decided on the runner's goroutine: status reaches snapshots through a 100 ms debounce, so a
  check in the command would let a second press through. `Manager.Compact` sets
  `Message.compact`, and `onThreadCmd` refuses with `compactHold`.
* **Refused** (FAILED_PRECONDITION): mid-turn, compacting, waiting for an answer, starting,
  restarting, an unfinished setup, no conversation yet. The last one also keeps a thread with no
  messages from being named "/compact". A typed `/compact` is unchanged: it still queues behind
  the turn.
* **Double click:** three layers. The chip and the row drop `detail > 1`; `compactThread` holds
  one call per thread, shared by both; the daemon refuses the rest. A press in the 100 ms after
  the call returned and before the status arrives gets the daemon's refusal as a toast.

## What it does to the timeline and Previous prompts

* The timeline is a typed `/compact`'s: the bubble, "Compacted the conversation" with its token
  figures, Claude's "Compacted", the turn's end. The bubble stays: it says what happened.
* Prompt history leaves it out through the existing marker: the item's `SentBy` is the thread
  itself. `promptPicker` already skips any `SentBy`, and nothing else reads it (it is not on the
  API), so no new origin was needed. A `/compact` the user typed stays in the history.

## Gotchas

* **Nothing may go before it.** `Send` starts a message with a resume note, and `sendMessage` with
  a reseed's prefix or a changed app memory. Any of those turns `/compact` into plain text for
  Claude to answer, which is likeliest on a stopped thread, the case the button must handle. They
  now wait for the next message. A typed `/compact`, or any typed slash command, still has this
  problem; left alone here.
* `PendingFirst` carries the flag, so a daemon stop before the handshake keeps it bare.
* `thread.compact` took the guide past `topics_test.go`'s soft cap, like every detailed Thread
  verb: its description is short and the cap moved 100 bytes (the hard limit stays 29,000).
* The context comes down without new code: the projector already takes `compact_boundary`'s
  `post_tokens`, and the result records it.
* Like any message, a compaction unarchives and unsnoozes the thread.
* The mock's `POST /__mock/thread/cache` with `tokens` and no `ago` now leaves the result's time
  alone. It used to default to an expired cache, which put the cold-cache note on screen.

## Verified

Real Claude Code 2.1.316, `claude-sonnet-5-5` at medium effort, `make drive DAEMON=dev`, scratch
repo, through the CLI:

* mid-turn: refused; at the prompt: `/compact`, compaction row 25,366 → 6,833 tokens, the thread's
  context 6,833; a second press at once: refused ("is already compacting");
* stopped thread: started and compacted; a press during the start refused ("is starting"); the
  next message still answered from the summary;
* `thread prompts` lists neither `/compact`.

`compactThread` from the GUI against the same daemon added a third compaction row and no toast.
The chip and row themselves were pressed only against the mock: a real thread at 400K was not
built for this.
