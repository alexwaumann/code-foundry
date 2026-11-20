# thread ask: how the answer arrives, and the lead hearing the result

Found while checking a release build by hand with Opus 5.5 threads: a lead was woken with
"worker is idle: waiting on 2 shells" twice for one question. The shells were the worker's
own: after `thread ask` it ran `sleep 90` in the background, then a four-minute timer, to
wait for the answer.

## Why the worker waited with tools

Three texts told it the answer "arrives at your next tool call": the created thread's
system prompt (`CreatedThreadPrompt`), `thread ask`'s help and its reply. That is true
while it works. With nothing left to do it read it as "make tool calls to get it".

## The wording

All three now say where the answer arrives in both cases and what not to do:

> The answer arrives as a message: at your next tool call, or as a new turn once yours has
> ended. Never wait for it with sleep, a timer or polling: with nothing left to do, end
> your turn.

`command.AskAnswerRule` is the help's and the reply's sentence; the system prompt says the
same in its own words (the thread store does not import the command package).

## What the wording exposed

With the new wording a blocked worker asks once and ends its turn. That turn's end is a
finish, so its creator's `--notify` subscription ends with that wake
(notify-ends-on-finish.md). The answer then reaches the worker as a message with no reply
wanted: the ask's wake tells the lead to answer with `thread send --reply none`, and a
passed-up answer from the user is sent the same way. Such a message renewed nothing, so the
worker's real result woke nobody and the lead never reported it. Before, the worker's timer
hid this: "waiting on shells" is not a finish, so the subscription lived on by accident.

## The rule

A message that answers the receiver's open thread ask to its sender renews the sender's
`--notify`, whatever its reply mark (`Message.answersAsk`, set by `Send` from
`Manager.answersAsk`: the sender is above the receiver, the receiver asked, and no message
from above came since). Everything else about a message with no reply wanted is unchanged:
no reply-wait, no wake for an fyi.

Not chosen: counting a worker with an unanswered ask as "not finished". The subscription
would then never end when the assumption was right and the lead, as told, said nothing.

## Checked with real threads

Opus 5.5 at medium effort, a lead and one worker per run, graded from the transcripts: the
lead's last reply carries the worker's result, and the worker made no sleep, timer or
background call.

| Scenario | Runs | Passed |
|---|---|---|
| The question passed up; the user answers after the worker's turn ended | 6 | 6 |
| The lead answers at once (the answer arrives mid-turn) | 3 | 3 |
| The lead answers after 25 seconds (the worker's turn has ended) | 3 | 3 |
| The worker carries on with an assumption and is corrected | 2 | 2 |
| The assumption is right; the lead says nothing | 2 | 2 |

Before the rule, with the wording alone, the first scenario failed: the lead's last reply
was "[nothing new]" and it held no subscription. A blocked worker's first turn went from
20.8 s and $0.24 to 7.6 s and $0.13.

## Tests

- `commands_thread_ask_test.go`: the reply and the help carry the rule; a repeated ask says
  only that nothing was sent.
- `subscriptions_until_test.go` `TestNotifyRenewedBySend`: the answer to an open ask renews
  with no reply wanted; another thread's message after an ask does not; a plain fyi still
  does not.
