# Reading wakes

{{cf.provenance}}

For the code-foundry-orchestrate skill: what a `[code-foundry wake]` message tells you
and what to do in the turn it starts. Every command runs in your Bash tool.

## Following up from a wake turn

From a wake turn, follow up with `thread send --id <child>` WITHOUT `--wait` and end the
turn (`send --wait` there holds back your other children's wakes); the send subscribes you
to it again, so its answer wakes you. Never subscribe or unsubscribe by hand for this.

## Finished

`needs attention (finished)` is a turn that ended normally, and the last wake from that
child until you `thread send` to it: a turn the user runs in it wakes nobody. A prompt, a
question, an error, a budget stop or a blocked or failed report is no finish: its finish
still comes. Under "It said" is the child's
own last message, whole: its result, and maybe a question asked in prose (answer with
`thread send --id <child>`). You need no `thread read` for it. `Report: blocked` or `failed`
is the child's own word that it could not finish.

Under "From the app, not the thread" is what git says, not the child's claim: the branch and
commit, pushed or not, uncommitted files, the diffstat against the base. Check the child's
claims against it; run git only for what it does not say.

## Pending prompts and questions

Each permission prompt or question wakes you on its own, with the tool's input (judge
that, not the child's description), a question's options and the `thread respond` line
that answers it. Answer every pending
request you can before relaying a child's question to the user as plain text at the end
of your turn (the child still asks with its own question tool; a blocking question tool
in YOUR turn holds back your other children). Supervised children:
`reference/patterns.md` §5.

## A child asks while it works

"asks you something and keeps working" is a child's `thread ask`: it did not stop, and goes on
with the assumption the wake quotes. If that assumption is right, say nothing. If not, answer at
once with `thread send --id <child> "..."`, without `--wait`: it reads that at its next tool
call. Only if you cannot answer, relay it to the user. A `thread wait` ends early for it and
prints the same; wait again after you answered.

## Budget stops

A budget stop is not finished work: tell the user and never raise a budget they set
unasked; raising alone does not resume the child, so resume it as
`reference/patterns.md` §6 shows.

## A batch of wakes

Children started with `--notify-group` come as one wake once they all settled; a failure, a
prompt or a question comes at once, and the others still come when the group settles. Use
plain `--notify` when one piece starts the next.

On a wake for a batch, look at the whole batch (`thread reports --created-by
$CODE_FOUNDRY_THREAD --all`; wakes can arrive seconds apart), and talk to the user only
when something needs them (a question, a failure, a conflict) or the batch is complete;
otherwise end the turn silently or with one short line ("done pushed; 2 still working").
No analysis of a partial batch. Do a check now or not at all: never promise one for
later. For a chain (B builds on A): one line when A is done and B started; the roll-up
once B is done. Routine approvals of a supervised child: no text at all.

## Messaging a child

Do not message a finished child only to inform it: every message starts a turn and a
wake. A `thread send` to a working child is read at its next tool call, not held: work
it already pushed stays pushed; `thread interrupt --id <id>` first if it must stop now.
When a follow-up changes the task, `thread rename --id <id> --name "<new name>"`.

## Interrupted

A settled wake for a child whose last turn end says `interrupted` means someone stopped
it: the user, or you with `thread interrupt`. Its last tool call shows `[running]` or an
error such as "was NOT written": that is the interrupt, not a rejection, and nothing is
wrong with the child. Check its worktree (`git status`, `git diff`: an edit may sit there
uncommitted), and for a user's interrupt ask the user before resuming; a `thread
interrupt` of your own you resume with `thread send --id <child>` saying what you checked.

A child whose process crashed (reason `crashed`, or the wake says its process died and
nobody stopped it) is not the user's interrupt: check its worktree the same way and
resume it once with `thread send --id <child>` without asking.

## After the app restarts

When a wake says the app restarted, or the user does: the restart wake lists the
interrupted children (`error (interrupted)`, reason "daemon stopped"); each lost its
current turn only. For each, check its worktree (`git status`, `git diff`), then `thread
send --id <child> "the app restarted; continue"` once. Subscriptions survive a restart:
do not subscribe again. `thread reports --created-by $CODE_FOUNDRY_THREAD --all` shows
what had been reported before the stop.

## Plugin wake sources

When a plugin names a wake source (`code-foundry thread subscribe --plugin
<plugin>/<source> --arg ...`), run it and end your turn; `code-foundry plugin wakes`.

## Timers

`code-foundry thread subscribe --every 30m` (or `--at 2h`, `--at <RFC 3339 time>`) wakes
you with `Timer sub-… fired at …` and JSON `kind: "timer"`, `due_at`, `every` or `at`.
Use it to look at slow work again later; `thread unsubscribe --timers` ends yours.
