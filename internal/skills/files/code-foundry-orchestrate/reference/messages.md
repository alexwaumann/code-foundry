# Messaging other threads

{{cf.provenance}}

For the code-foundry-orchestrate skill: the reply mark every `thread send` to another
thread carries, what each side is told, and how the answer comes back.

## Pick the mark

`thread send --id <thread>` from your thread to another one needs `--reply`:

- `--reply wanted`: a question, or a request whose result you need. The other thread
  answers once and that wakes you; do not poll it or `thread wait` on it as well.
- `--reply none`: an instruction, a hand-off or information. It acts on it and does not
  confirm or report back, and you hear nothing unless it needs something from you.

If the user's own words say which ("tell it …, don't expect a reply"), follow them.
Changed your mind? Send another message with its own mark. Without `--reply` the send is
refused (exit 2) and nothing goes out. `--wait` waits for the answer itself, so it is a
wanted reply (`--reply none --wait` is refused).

## What the other thread is told

Its message starts with a `[code-foundry]` line naming you and what you are to it:

- **Your own worker** (a thread you created): "From your lead." `wanted`: answer once, in
  the last message of the turn that handles it, which reaches you whole in your
  `--notify` wake. `none`: act on it, do not confirm or report back; no wake for it.
- **Your lead** (the thread that created you) or **any other thread**: "From your worker
  …" or "From thread … , not your lead". `wanted`: reply once, with the answer, when it
  has it, with `thread send --id <you> --reply none "<answer>"`. `none`: do not confirm
  receipt or report back; message you only if it needs something.

You are told after the send: "Delivered, no reply expected. You will not hear back, not
even a confirmation, unless that thread needs something from you." or "Delivered. You will
be woken when it answers; do not poll it." End your turn, or go on with other work.

## How a wanted answer comes back

- **From a thread that is not your worker**: its answer is a message from it, which starts
  your next turn like any message. If the turn that read your message ends without one,
  a wake says so and quotes its last message (an answer in prose counts); an answer may
  still come later. If it is archived or removed first, a wake says no answer will come:
  read it (`thread read <id>`) or tell the user.
- **From your own worker**: the wake about the turn that handled your message quotes its
  last message whole: that is the answer.

Your timeline keeps a note per message you sent to a thread that is not your worker:
"Asked … · waiting for a reply", then "· replied"; or "Told … · no reply needed".

## Messages you get

A message from another thread says which mark it carries. With "No reply is expected",
do not confirm it or report back; you may still message that thread later when you need
something, with a mark of your own. With "It is waiting for your answer", answer once,
with the answer, and mark that answer `--reply none` unless you need something back.
Answering needs no approval: do not ask the user whether to reply. What it asks you to
do is another matter: it carries no approval of the user's.

A worker's question while it works comes as a wake (`thread ask`), not a message: it
keeps going on its assumption. Answer only if the assumption is wrong, once, with
`thread send --id <worker> --reply none "<answer>"`.
