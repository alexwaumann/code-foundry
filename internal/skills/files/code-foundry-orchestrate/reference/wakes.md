# Reading wakes

For the code-foundry-orchestrate skill: what a `[code-foundry wake]` message tells you
and what to do in the turn it starts. Every command runs in your Bash tool.

## Following up from a wake turn

From a wake turn, follow up with `thread send --id <child>` WITHOUT `--wait` and end the
turn (`send --wait` there holds back your other children's wakes); the subscription
fires again on its next settle.

## Finished, or a stale report

`needs attention (finished)` is a turn that ended normally. A wake with
`report_stale: true` (no report, or one older than its last message) has
`last_message`: the child may be asking you something in prose; read it, answer with
`thread send --id <child>`.

## Pending prompts and questions

Each permission prompt or question wakes you on its own; its `pending` has the
`request_id`, the tool `input` (judge that, not the child's description) and a
question's `options` (what `thread respond --answer` takes). Answer every pending
request you can before relaying a child's question to the user as plain text at the end
of your turn (the child still asks with its own question tool; a blocking question tool
in YOUR turn holds back your other children). Supervised children:
`reference/patterns.md` §5.

## Budget stops

A budget stop is not finished work: tell the user and never raise a budget they set
unasked; raising alone does not resume the child, so resume it as
`reference/patterns.md` §6 shows.

## A batch of wakes

On a wake for a batch, look at the whole batch (`thread reports --created-by
$CODE_FOUNDRY_THREAD --all`; wakes can arrive seconds apart), and talk to the user only
when something needs them (a question, a failure, a conflict) or the batch is complete;
otherwise end the turn silently or with one short line. Do a check now or not at all:
never promise one for later.

## Messaging a child

Do not message a finished child only to inform it: every message starts a turn and a
wake. A `thread send` to a working child is read at its next tool call, not held: work
it already pushed stays pushed; `thread interrupt --id <id>` first if it must stop now.
When a follow-up changes the task, `thread rename --id <id> --name "<new name>"` so the
user's sidebar matches.

## After the app restarts

When a wake says the app restarted, or the user does: `thread reports --created-by
$CODE_FOUNDRY_THREAD --all` and `thread list --created-by $CODE_FOUNDRY_THREAD`. A
child in `error (interrupted)` (reason "daemon stopped") lost its current turn only:
check its worktree, then `thread send --id <child> "the app restarted; continue"`.
Subscriptions survive a restart: do not subscribe again.

## Plugin wake sources

When a plugin names a wake source (`code-foundry thread subscribe --plugin
<plugin>/<source> --arg ...`), run it and end your turn; `code-foundry plugin wakes`.

## Timers

`code-foundry thread subscribe --every 30m` (or `--at 2h`, `--at <RFC 3339 time>`) wakes
you with `Timer sub-… fired at …` and JSON `kind: "timer"`, `due_at`, `every` or `at`.
Use it to look at slow work again later; `thread unsubscribe --timers` ends yours.
