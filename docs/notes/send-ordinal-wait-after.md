# Send ordinal, wait after the latest message, respond's pending tail

Follow-up to the 2026-10-18 Haiku orchestration experiment (`/tmp/cf-exp/results`,
REPORT.md B1 and B7, e5.md finding 2, w2a findings 2 and 4). An orchestrator that ran
`thread send` (no `--wait`) and then a plain `thread wait` got the previous turn's
"needs attention (finished)" back in 16 ms, because the send had not flipped the child to
busy yet (E5 hit it twice; reproduced deterministically).

## What changed

* **`thread wait` without `--after` waits for Claude's answer to the thread's latest
  message.** The daemon (`api.Thread.Wait`) resolves an empty `after` to the latest
  top-level user message, a wake message included (`lastMessage`), and counts the
  condition only once a reaction follows it (a top-level turn end, error, permission
  request or question: `isReaction`, unchanged). A thread with no message has nothing to
  react to: no check, as before. An explicit `--after` is honoured as before. The proto
  comment on `WaitThreadRequest.after` says so.
* **`thread send` prints the message's ordinal and the race-free wait**:
  `sent to thread s-… (#13); wait with: code-foundry thread wait s-… --after 13`.
  `send --wait`'s timeout starts `sent to thread s-… (#13); timed out …`. `--json` is
  unchanged (the message item).
* **`thread respond` names what is still pending**: `Write notes.txt: allowed (allow);
  1 more pending: permission: Bash Create empty other.txt file (request 4097…)`, or
  `…; nothing pending`. `--json` is unchanged (the answered item).
* **Supervised help says what Claude's manual mode does**: "asks before edits and
  commands; read-only ones run unasked" (was "confirm every tool call"; w2a saw reads and
  read-only Bash run unasked). Same wording in the proto, store and pluginsdk comments;
  the GUI's mode picker hint reads "Edits and commands ask; reads run" (`lib/compose.ts`)
  and a supervised prompt's hint "Supervised asks before edits and commands"
  (`lib/threadRequest.ts`). Text only.
* The guide's "Do not poll" line says a wait counts only once the thread answered its
  latest message.

## Decisions

* **Daemon-side default, not a CLI lookup.** The CLI could have read the last user
  item (`ListItems` with `role` and `last`, twice: user and wake are separate roles) and
  passed it as `after`; the daemon already reads the items for `after`, after
  subscribing to the item events, so resolving the default there costs nothing extra and
  is race-free with a send that just returned (the send's item is in the store before
  `Send` answers). Only the CLI calls `ThreadService.Wait`, so changing what an empty
  `after` means touches no other client. Every wait now subscribes to item events and
  reads the items once (it did only with `after` before).
* **Subagent prompts do not count** (`ParentToolUseID` set), so a subagent's turn cannot
  stand in for the thread's message; wake messages do, since a wake starts a turn like
  any message.
* **Respond waits briefly from the CLI.** Claude asks for parallel tool calls one after
  the other, the next a few ms after an answer (w2a: 15 ms), so reading the pending list
  at once said "nothing pending" in the first end-to-end run. From the CLI (no view in the
  command context) respond now waits up to 500 ms (`respondSettle`) for Claude's next
  request or the turn's end (`ThreadService.Wait`, until attention, after the answered
  item) before reading the pending list. The GUI invokes `thread.respond` too, with a
  "thread" view; it shows the next prompt itself, so it does not wait.
* To fit the guide under its 29,000-byte cap, `thread.send --wait`/`--for`,
  `thread.wait`/`--until`, `thread.set-mode` and `thread.respond` lost repeated wording
  (the duration format and "exits 1" live on `thread.wait`; the answer format on
  `--answer`). The guide is at 28,965 bytes.
* Not done here: the skill text (another PR); wake on each new pending request
  (REPORT C2).

## Gotchas

* `internal/store/thread` `TestPluginWakes` fails about 2 in 10 runs on main too (the
  first wake may be the broad subscription's); unrelated, rerun.
* The threadtest fake's pending requests now carry the store's `<Tool> <description>`
  summary for permissions.

## End to end (2026-10-19, isolated `CODE_FOUNDRY_HOME=/tmp/sowa-home`, Haiku 5.5 medium)

Scratch project `~/cf-exp-scratch/sowa-todo` (cloned from the todo template with a bare
origin). Before: the e5 repro, send then wait, returned the stale "finished" in 16 ms;
step 5 below shows the same stale answer when an older `--after` is given on purpose.

```
## 2. send (no --wait), then a plain wait at once
[00:58:49.650] $ code-foundry thread send --id s-0b48e59d8aca Now reply with exactly the word TWO. Do not use any tools.
sent to thread s-0b48e59d8aca (#4); wait with: code-foundry thread wait s-0b48e59d8aca --after 4
[00:58:49.697] $ code-foundry thread wait s-0b48e59d8aca --for 2m
thread s-0b48e59d8aca e2e wait: needs attention (finished)
[00:58:50.841] exit 0
#4 you: Now reply with exactly the word TWO. Do not use any tools.
#5 claude: TWO
#6 turn end: success, 1.1s, ...

## 3. send, then the printed hint pasted as is
sent to thread s-0b48e59d8aca (#7); wait with: code-foundry thread wait s-0b48e59d8aca --after 7
[00:58:50.924] $ code-foundry thread wait s-0b48e59d8aca --after 7
thread s-0b48e59d8aca e2e wait: needs attention (finished)
[00:58:51.843] exit 0
#8 claude: THREE

## 4. idle thread, no new message: plain wait returns at once
[00:58:51.934] $ code-foundry thread wait s-0b48e59d8aca
thread s-0b48e59d8aca e2e wait: needs attention (finished)
[00:58:51.966] exit 0

## 5. explicit --after older than the latest message is honoured
[00:58:52.001] sent to thread s-0b48e59d8aca (#10); wait with: code-foundry thread wait s-0b48e59d8aca --after 10
[00:58:52.019] $ code-foundry thread wait s-0b48e59d8aca --after 1
thread s-0b48e59d8aca e2e wait: needs attention (finished)        <- the old turn, 41 ms
[00:58:52.072] $ code-foundry thread wait s-0b48e59d8aca --for 2m
thread s-0b48e59d8aca e2e wait: needs attention (finished)
[00:58:52.929] exit 0                                              <- after #12 turn end (FOUR)

## 6. a longer turn: send, then a plain wait
[00:59:11.302] $ code-foundry thread send --id s-0b48e59d8aca Run the shell command 'sleep 6; echo slept' ...
sent to thread s-0b48e59d8aca (#13); wait with: code-foundry thread wait s-0b48e59d8aca --after 13
[00:59:11.344] $ code-foundry thread wait s-0b48e59d8aca --for 3m
thread s-0b48e59d8aca e2e wait: needs attention (finished)
[00:59:20.229] exit 0                                              <- 8.9 s, after #16 turn end

## 7. supervised: respond prints what is still pending
[01:02:08.602] $ code-foundry thread wait s-4ac8659ce749 --until attention --for 3m
thread s-4ac8659ce749 e2e supervised 2: needs attention (permission: Write notes.txt)
[01:02:11.297] $ code-foundry thread respond --id s-4ac8659ce749 allow
Write notes.txt: allowed (allow); 1 more pending: permission: Bash Create empty other.txt file (request 4097e4c8-351a-4d5a-91e6-932829cff509)
[01:02:11.416] exit 0
[01:02:11.478] $ code-foundry thread respond --id s-4ac8659ce749 allow
Bash Create empty other.txt file: allowed (allow); nothing pending
[01:02:12.023] exit 0

## 8. thread new, then a plain wait at once
[01:02:22.898] $ code-foundry thread wait s-7c8ab711f052 --for 3m
thread s-7c8ab711f052 e2e new-wait: needs attention (finished)
[01:02:31.501] exit 0                                              <- after the first turn (sleep 4)
```

`code-foundry help thread new`: `--permission supervised|accept-edits|auto  Permissions:
supervised (asks before edits and commands; read-only ones run unasked), accept-edits
(file edits allowed), or auto (Claude's auto mode) (default "auto")`.
