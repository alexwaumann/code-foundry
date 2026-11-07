# thread ask: a child asks its creator and keeps working (2026-11-07)

Third of the wake changes. A child had two ways to ask, and both stopped it: a question in prose
at the end of its turn, or its question tool, which holds the turn. `thread ask "question"
--assuming "what I do meanwhile"` sends its creator a wake and returns.

## Decisions

- **Only the upward half is new.** `thread send` already reaches a working thread at its next
  tool call, so an answer needs nothing.
- **`--assuming` is required.** A thread that goes on has to go on doing something, and with it
  the creator can say nothing when the assumption is right: every answer is a turn.
- **An ask is a wake**: labelled, starts an idle creator, counts against the wake limit (over it,
  the ask fails and says to go on). It goes alone and at once, not through the batch window. Its
  JSON is `kind: "ask"`, so the GUI draws the usual "Woken by" row.
- **The same question within a minute is not sent** (`repeated`), after Claude Code's own
  cross-session messaging, which drops identical repeats.
- **`thread wait` ends early on an ask from a thread the waiter created** (`by_thread_id`): the
  wake queues behind the very call that waits, and the child would go on unanswered. Only the
  creator's own wait ends, so a script's `thread wait` from outside never does. The wake still
  follows, so a waiter sees it twice: a few lines, against a wait that could run 30 minutes.
- **No creator, or a gone one: refused**, pointing at the question tool. Nothing reaches the user.
- **Messages from a thread that is not the receiver's creator now say so.** A child's `thread send`
  to its parent read as the user's own: `Item.SentBy` is never shown to the model. A creator's
  messages stay plain, since they are its child's task.
- **Parents relay, children do not talk to each other.** Sibling messages would mean N² paths and
  loops; the parent already sees everything.

## Limits

An ask that lands just before the creator's `thread wait` starts does not end that wait: only
asks after its start do, or re-waiting would return the same question. Its wake comes when the
wait ends, and the child goes on with its assumption meanwhile.

`thread send --by` is the caller's word, so a thread can avoid the sender line by naming the
receiver or its creator. The line is an honest label, not a security boundary.

## Results

`w4-ask` (a decision the README leaves open and only the parent knows), 3 runs a side:

| | before | this change |
|---|---|---|
| Children that stopped to ask | 3 (1 question tool, 2 in prose) | 0 |
| Children that asked and kept working | 0 | 3 |
| Mean run | 89 s | 71 s |
| Cost | $1.15 | $1.11 |

The other 18 runs of the stack had no ask at all, so the prompt line does not make children chatty.
Cognition reports sub-agents do not write back to a manager by default; told the verb exists, these
did. All six runs got the right answer: the task shows how a child asks, not whether it finds out.
Three runs of one task, on Sonnet 5.5 low children.
