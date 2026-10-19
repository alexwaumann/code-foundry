# Agents, PR 4: wake subscriptions (2026-10-17)

The fourth of five PRs that make threads drivable by agents (PR 1:
`agents-1-wait-events.md`, PR 2: `agents-2-metadata.md`, PR 3: the GUI). Claude Code is
turn-based: a thread's agent only runs when a message arrives. A "foreman" thread that
started children now asks the daemon to wake it when a child settles (or an action run
finishes) instead of polling: the daemon sends it a message through Send. Daemon, proto
and CLI only; the GUI maps the new item fields into its view model and draws nothing new
yet.

## Decisions

Agreed with Alex (the brief):

* **Targets**: threads and action runs (PR checks later).
* **Delivery** is a normal message into the subscriber through the store's Send, so a
  busy subscriber queues it, a stopped one starts with it (a DISCONNECTED idle subscriber
  is started: that is the point) and a snoozed one is unsnoozed (Send's `backToList`).
  The text is one header line and a fenced JSON block:

  ````
  [code-foundry wake] Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
  ```json
  { "kind": "thread", "subscription_id": "sub-…", "condition": "settled", "fired_at": "…",
    "thread": { "id", "name", "state", "status", "status_reason", "repo_id", "worktree_path",
                "created_by", "labels", "report": { "status", "summary", "data", "at" } } }
  ```
  ````

  Since `wake-detail.md` (2026-10-19) the header reads `needs attention: finished
  without a report.` here, and the JSON adds `report_stale`, `last_message`,
  `pending` and `children`; settled and attention subscriptions also fire on each new
  pending request.

  A run: `[code-foundry wake] Action "Slow" run r-… finished with exit 3.` and
  `{ "kind": "action_run", …, "run": { id, action_id, action_name, repo_id, exit_code,
  started_at, finished_at, output_tail } }` (the last 4 KiB of the output).
* **The item is marked**: `UserMessageItem.origin` (`MessageOrigin`: UNSPECIFIED for old
  items, USER, WAKE), `wake_title` (the header without `[code-foundry wake] `) and
  `wake_json` (the payload), so the GUI can draw a collapsed "Woken by …" row. Persisted in
  the item's data (`origin`, `wake_title`, `wake_json`). Only the daemon sets them: the
  Send RPC has no origin field.
* **Conditions** for a thread: `idle`, `attention`, `error`, `disconnected` (exactly
  `thread.wait`'s, PR 1's wide `idle` included) and `settled` = idle or attention.
  Edge-triggered on a transition into the condition, and once at once when the target
  already meets it at subscribe time. A run's only condition is `finished`; its
  subscription goes once it fired.
* **Once by default**, `--repeat` for every transition. A one-shot goes once it fired.
* **Loop guard**: no subscription to yourself, none whose reverse exists (the target
  already subscribes to the subscriber): FailedPrecondition saying it would loop.
* **Rate cap**: 60 wakes per subscriber per rolling hour. Beyond: the wake is dropped and
  logged (warn), and once per hour window the subscriber needs attention, status reason
  `wake limit` (in the proto's reason list), with the note "Wake limit reached
  (60/hour); wakes are being dropped." Subscriptions stay.
* **Cleanup**: archiving or removing the subscriber or the target thread deletes its
  subscriptions. Persisted in `thread_subscriptions` (migration 0024) and rehydrated at
  startup. Runs live in the action store's memory (`actions-1-daemon.md`, checked: no
  table), so run subscriptions are dropped at startup.
* **`thread.new --notify`** (with `created-by`, PR 2's arg, `$CODE_FOUNDRY_THREAD` by
  default) subscribes the creator to the child: settled, repeat, in the same call.
* Commands `thread.subscribe`, `thread.unsubscribe`, `thread.subscriptions`; RPCs
  `ThreadService.Subscribe`, `Unsubscribe`, `ListSubscriptions`.

Decided while building (not in the brief; flagged for review):

* **The engine runs in the store's commit**, not on a bus subscription: `commitLocked`
  (every published thread change, under `m.mu`) calls `observeLocked`, and `Remove` calls
  `forgetLocked`. Subscribe also runs under `m.mu`, so registration and changes are
  totally ordered: no stale queued event can re-arm a subscription that just fired at
  once (a double wake), and no change is lost to a full bus buffer. The hook only decides
  and queues; delivery is one goroutine per subscriber (`drain`, in order, through the
  public Send, never under `m.mu`).
* **`thread.Meets` is the one condition table.** `ThreadService.Wait` now calls it too;
  PR 1's table test (`api/thread_wait_test.go`) runs the same cases against it.
* **A one-shot that fires at subscribe time is never stored**: the answer says
  `fired`, with `fired_count` 1, and it is not listed.
* **The same subscription twice** (subscriber, target, condition) returns the existing
  one (`existed`), with `repeat` updated, and fires nothing.
* **Archived threads are refused** as subscriber or target (FailedPrecondition).
  Unarchiving does not bring deleted subscriptions back.
* **Nothing fires for what happened while the daemon was stopped**: rehydrated
  subscriptions are armed with the targets as loaded, and nothing fires while the store
  shuts down (its runners' ends still commit). A child interrupted by a daemon restart
  (busy becomes error "interrupted") therefore does not wake its parent; the next turn of
  the child does. Waking every foreman at startup seemed worse (the restart stopped the
  foreman too).
* **The rate window is in memory** (a restart starts over). A dropped wake does not
  count in `fired_count`; a one-shot dropped by the cap stays and waits for the next
  transition; a run subscription dropped by the cap goes (the run will not end again).
  The limit's note and status come with the first drop in a window (`Options.WakeLimit`
  lowers it in tests).
* **"wake limit" ranks below working**: a busy subscriber says busy; once Claude stops
  it reads "wake limit" (above "finished"); the next message or a viewer clears it, like
  "finished". On a stopped subscriber it is set on the row (persisted) with the note.
* **The JSON**: a top-level `condition`; `report.data` embedded as a JSON object (not a
  string), `report` null when none; `labels` `[]` when none; times RFC 3339 UTC with
  milliseconds; `status` snake_case (`needs_attention`), `state` lowercase.
* **The header**: `settled` says "is idle" when idle holds, else "needs attention"; a
  report adds `Report: <status> — <summary>.`, the summary on one line and cut at 200
  runes (the JSON has it whole); an unnamed thread is `Thread s-…`. The child is often
  still unnamed at its first wake (auto-naming races the first turn; e2e below).
* **`output_tail` is empty for a terminal run** (only background runs capture output).
* **The thread store does not know the action store**: `Options.ActionRun` looks a run
  up (the daemon adapts `action.Manager.GetRun`), and the daemon's glue
  (`internal/daemon/wake.go`) calls `Manager.ActionRunFinished` for every
  `run_finished`. It stops before the action store kills background runs at shutdown, so
  a killed run wakes nobody.
* **`--notify`** without `created-by` is InvalidArgument (in the command, before any
  call, and in the store); with an archived creator FailedPrecondition, before anything
  is made. Once the thread exists, a failed subscribe is logged, not returned.
* **CLI output**: `thread subscribe --json` prints the whole response (`subscription`,
  `fired`, `existed`), `unsubscribe` `{removed}`, `subscriptions` `{subscriptions}`.
  `thread items` prints a wake as `#5 wake: <title>`. The three commands are
  NoKeybinding (agent verbs and a query). `thread.unsubscribe` takes the subscription id
  positionally, or `--thread`/`--run` for the context thread (`--id`).
* `thread_subscriptions.subscriber_thread_id` references `threads` ON DELETE CASCADE;
  the target has no foreign key (a run is not a row; the store deletes a thread target's
  rows itself).

## What was built

* **Proto**: `thread_subscriptions.proto` (new): `ThreadSubscriptionTarget`,
  `ThreadSubscriptionCondition`, `ThreadSubscription` (with read-time
  `subscriber_name`, `target_name`, `target_status`), the three request/response pairs.
  `thread.proto`: the three RPCs, `UserMessageItem.origin/wake_title/wake_json`,
  `MessageOrigin`. `thread_lifecycle.proto`: `CreateThreadRequest.notify` (19), "wake
  limit" in `status_reason`'s comment. Generated Go and TS committed.
* **Migration `0024_thread_subscriptions.sql`**: `thread_subscriptions(id, subscriber_thread_id
  → threads ON DELETE CASCADE, target_kind, target_id, condition, repeat, created_at,
  fired_count, last_fired_at)`, STRICT, an index on the subscriber.
  `internal/db/thread_subscriptions_migration_test.go`.
* **Store** (`internal/store/thread`):
  * `subscriptions.go` (new): `Condition`, `TargetKind`, `Meets`, `Subscription`,
    `SubscribeOptions/Result`, `UnsubscribeOptions`, `ActionRun`, the state
    (`subscriptions`, lock order `m.mu` then its own), `loadSubscriptionState`
    (rehydrate), `Subscribe`/`subscribe` (validation, the loop guard, fire at once),
    `observeLocked` (the hook), `ActionRunFinished`/`fireRun`, `forgetLocked`,
    `Unsubscribe`, `Subscriptions`, `checkNotify`/`notifyCreator`.
  * `subscriptions_fire.go` (new): `fireLocked` (rate cap, counts), the per-subscriber
    queue and `drain`, `wakeLimitReached` (runner command on a live thread, row and note
    on a stopped one), `runner.onWakeLimit`, the payloads and headers.
  * `subscriptions_db.go` (new): load, upsert, delete.
  * Edits: `thread.go` (Store methods, `CreateOptions.Notify`), `manager.go`
    (`Options.ActionRun`, `Options.WakeLimit`, `Manager.subs`, the hooks in
    `commitLocked` and `Remove`, rehydrate in `New`, notify in `Create`), `items.go`
    (`Item.Origin/WakeTitle/WakeJSON`, `Message` the same, `MessageOrigin`), `items_db.go`,
    `stream.go` (`outgoing` fields, `threadCmd.wakeLimit`), `lifecycle.go` (`userItem`),
    `conversation.go` (Send passes the origin), `stream_status.go` (`wakeLimit`).
  * `threadtest/subscriptions.go` (new) and `fake.go`'s Create (`notify`): the fake keeps
    subscriptions, validates like the store, never fires (`Fired` is set when a thread
    target already meets the condition).
* **API**: `internal/api/thread_subscriptions.go` (new): the three handlers, the mapping,
  `userMessageToProto`. `thread.go` maps items through it; `thread_lifecycle.go` maps
  `notify`; `thread_wait.go` uses `thread.Meets`.
* **Commands**: `commands_thread_subscribe.go` (new): `thread.subscribe`,
  `thread.unsubscribe`, `thread.subscriptions`, `SubscriptionBackend` (embedded in
  `ThreadBackend`). `commands_thread_lifecycle.go`: `thread.new --notify`.
  `commands_thread.go`: registration, `thread.items`' `wake:` line.
  `commandtest/thread_subscriptions.go` (new).
* **Daemon**: `internal/daemon/wake.go` (new): `actionRunForWake`, `startWakeRuns`;
  `stores.go` wires both and stops the glue before the action store closes.
* **GUI view model only** (`gui/frontend/src/api/thread.ts`): the user item's optional
  `wake: WakeView | undefined` (`title`, `json`), set for origin WAKE. No component reads
  it yet (PR 3's or a follow-up's row).

## Tests

* Store (`subscriptions_test.go`): `Meets` (every condition on 13 states), the target and
  condition validation, header and payload (JSON keys, report data, unnamed, every
  condition's wording, one-line summaries, the output tail on a rune boundary),
  transitions for each condition both repeat and once (fire counts, one-shots gone, the
  wakes delivered into the subscriber's items), fire at once (the stopped subscriber
  starts and answers; repeat armed; the same subscription again; the origin kept across a
  restart), the refusals (self, a direct cycle, archived subscriber or target, unknown
  threads, two targets, no action store), unsubscribe by target and id (persisted),
  cleanup on archive and remove of either side (persisted), rehydrate (counts kept,
  nothing fires at startup, run subscriptions dropped, the next transition fires),
  run subscriptions (fires once on `ActionRunFinished`, at once for a finished run,
  unknown run), `Notify`, the wake limit on a fake clock (two wakes, one note, the status,
  the window rolls) and its status table.
* API (`thread_subscriptions_test.go`): mapping both ways, codes, the origin of items.
* Commands (`commands_thread_subscribe_test.go`): every message, request and argument
  error; `thread_test`'s items line; registry and NoKeybinding lists.
* Daemon (`wake_test.go`): run_finished forwarding, the run adapter. Frontend:
  `api/thread.test.ts`.

## Gotchas

* `thread.new` has no positional prompt: the brief's `"say hi then stop"` is `--prompt`.
* The CLI exits 2 with the usage hint for FailedPrecondition (the loop guard), as for any
  daemon refusal of arguments; a script reads the message.
* Claude repeats the payload's words back ("status needs_attention"): the header is what
  it reads first, the JSON what a script parses.
* `TestRenderedStartCrash` failed once under `make check`'s parallel load (the fake
  claude exits before the daemon's first write, so the start fails "spawn failed" with a
  broken pipe instead of "crashed"); 30 runs alone passed. Pre-existing race, unrelated.
* The worktree-isolation hook refused command lines with `[1m]` model ids and `$(cat …)`
  prompts; the e2e ran from small scripts calling a wrapper `cf` (the branch binary with
  `CODE_FOUNDRY_HOME=/tmp/cf-pr4`).

## End to end (2026-10-17, isolated home, scratch repo under ~)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr4 bin/code-foundry daemon --dev` (no
`CODE_FOUNDRY_*` in the environment); `~/cf-scratch-pr4` with a README, registered and
`repo.git.init`ed (`e7124810184e`). `code-foundry` below is the branch binary with that
home. Model `claude-haiku-5-5[1m]`, effort medium. Output as printed.

```
$ cat parent-prompt.txt
Use your Bash tool to run exactly this one command and nothing else: …/bin/code-foundry thread new --repo e7124810184e --model 'claude-haiku-5-5[1m]' --effort medium --notify --brief "say hi and stop" --prompt "say hi then stop"
Then end your turn by replying with the single word started. Do not wait for the new thread. When a message starting with [code-foundry wake] arrives later, reply in one short sentence saying which thread finished and what its status was.
$ code-foundry thread subscriptions --all
no wake subscriptions
$ code-foundry thread new --repo e7124810184e --model 'claude-haiku-5-5[1m]' --effort medium --name "pr4 foreman" --prompt "$(cat parent-prompt.txt)"
created thread pr4 foreman (s-867564981c98) in /Users/alex/cf-scratch-pr4
$ sleep 20; code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     1      04:01:08    needs attention (finished)
$ code-foundry thread items --id s-867564981c98
#1 you: Use your Bash tool to run exactly this one command and nothing else: /Users/alex/projects/code-foundry/.claude/worktrees/agent-a232e1c3c4ea87559/bin/code-foundr…
#2 tool Bash [done] {"command":"/Users/alex/projects/code-foundry/.claude/worktrees/agent-a232e1c3c4ea87559/bin/code-foundry thread new --repo e7124810184e --model 'claude-haiku-5-…
    → created thread s-7754a478e649 in /Users/alex/cf-scratch-pr4; s-867564981c98 is woken each time it settles
#3 claude: started
#4 turn end: success, 3.1s, 48068 in / 195 out tokens, $0.0029, $0.0029 so far, claude-haiku-5-5
#5 wake: Thread s-7754a478e649 is idle: finished.
#6 claude: Thread s-7754a478e649 finished with status "needs_attention" (reason: finished).
#7 turn end: success, 1.0s, 25450 in / 32 out tokens, $0.0003, $0.0033 so far, claude-haiku-5-5
$ code-foundry thread items --id s-867564981c98 --json | jq '.items[] | select(.userMessage.origin == "MESSAGE_ORIGIN_WAKE") | .userMessage | {origin, wakeTitle}'
{
  "origin": "MESSAGE_ORIGIN_WAKE",
  "wakeTitle": "Thread s-7754a478e649 is idle: finished."
}
$ code-foundry thread items --id s-867564981c98 --json | jq -r '.items[] | select(.userMessage.origin == "MESSAGE_ORIGIN_WAKE") | .userMessage.text'
[code-foundry wake] Thread s-7754a478e649 is idle: finished.
```json
{
  "kind": "thread",
  "subscription_id": "sub-2e4a9c05f6eb",
  "condition": "settled",
  "fired_at": "2026-10-17T09:01:08.732Z",
  "thread": {
    "id": "s-7754a478e649",
    "name": "",
    "state": "connected",
    "status": "needs_attention",
    "status_reason": "finished",
    "repo_id": "e7124810184e",
    "worktree_path": "/Users/alex/cf-scratch-pr4",
    "created_by": "s-867564981c98",
    "labels": [],
    "report": null
  }
}
```
$ code-foundry thread items --id s-7754a478e649
#1 note: Created by pr4 foreman · brief: say hi and stop
#2 you: say hi then stop
#3 claude: Hi!
#4 turn end: success, 1.6s, 22326 in / 6 out tokens, $0.0016, $0.0016 so far, claude-haiku-5-5
```

The child was not named yet when it settled (`"name": ""`); later wakes have its name. A
late subscriber, the loop guard, the self guard, a repeated subscribe:

```
$ code-foundry thread subscribe --id s-867564981c98 --thread s-7754a478e649 --until idle
woke s-867564981c98 at once: thread s-7754a478e649 already met the condition (idle); the one-shot subscription sub-28ce22fd7e18 is done
exit=0
$ code-foundry thread subscribe --id s-7754a478e649 --thread s-867564981c98
code-foundry thread.subscribe: failed precondition: thread s-867564981c98 already subscribes to thread s-7754a478e649 (sub-2e4a9c05f6eb); subscribing back would wake them in a loop
Run `code-foundry help thread.subscribe` for usage.
exit=2
$ code-foundry thread subscribe --id s-867564981c98 --thread s-867564981c98
code-foundry thread.subscribe: failed precondition: thread s-867564981c98 cannot subscribe to itself
Run `code-foundry help thread.subscribe` for usage.
exit=2
$ code-foundry thread subscribe --id s-867564981c98 --thread s-7754a478e649 --repeat --json
{"subscription":{"id":"sub-2e4a9c05f6eb", "subscriberThreadId":"s-867564981c98", "target":"THREAD_SUBSCRIPTION_TARGET_THREAD", "targetId":"s-7754a478e649", "condition":"THREAD_SUBSCRIPTION_CONDITION_SETTLED", "repeat":true, "createdAt":"2026-10-17T09:01:06.662Z", "firedCount":"1", "lastFiredAt":"2026-10-17T09:01:08.732Z"}, "existed":true}
exit=0
$ sleep 12; code-foundry thread items --id s-867564981c98     # #1 to #7 as above
#8 wake: Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
#9 claude: Thread "Say hi and stop" (s-7754a478e649) finished with status "needs_attention" (reason: finished).
#10 turn end: success, 1.3s, 25770 in / 42 out tokens, $0.0003, $0.0036 so far, claude-haiku-5-5
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     1      04:01:08    needs attention (finished)
```

An action run:

```
$ code-foundry action add Slow --command 'sleep 5; echo built 42 files; exit 3' --icon build --in-terminal=false --repo e7124810184e
added action Slow (a-f908b11a2fd9)
$ code-foundry action run slow --background --context-worktree /Users/alex/cf-scratch-pr4 --json | jq -r .id
r-f5aed3e9907d
$ code-foundry thread subscribe --id s-867564981c98 --run r-f5aed3e9907d
subscribed sub-d414ee01cad6: s-867564981c98 wakes when run r-f5aed3e9907d finishes (once)
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL     REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled   yes     1      04:01:08    needs attention (finished)
sub-d414ee01cad6  s-867564981c98 (pr4 foreman)  run r-f5aed3e9907d (Slow)                finished  no      0      -           running
$ code-foundry thread subscribe --id s-867564981c98 --run r-f5aed3e9907d --until idle
code-foundry thread.subscribe: an action run's only condition is finished, not idle
Run `code-foundry help thread.subscribe` for usage.
exit=2
$ code-foundry action wait r-f5aed3e9907d
built 42 files
Slow exited with code 3 (run r-f5aed3e9907d)
$ sleep 10; code-foundry thread items --id s-867564981c98 | tail -3
#12 thinking
#13 claude: Action "Slow" run r-f5aed3e9907d finished with exit code 3 (not a thread; its last output was "built 42 files").
#14 turn end: success, 1.7s, 26106 in / 193 out tokens, $0.0004, $0.0040 so far, claude-haiku-5-5
$ code-foundry thread items --id s-867564981c98 --json | jq -r '… .userMessage.wakeJson' | tail -14
  "subscription_id": "sub-d414ee01cad6",
  "condition": "finished",
  "fired_at": "2026-10-17T09:02:40.553Z",
  "run": {
    "id": "r-f5aed3e9907d",
    "action_id": "a-f908b11a2fd9",
    "action_name": "Slow",
    "repo_id": "e7124810184e",
    "exit_code": 3,
    "started_at": "2026-10-17T09:02:35.488Z",
    "finished_at": "2026-10-17T09:02:40.553Z",
    "output_tail": "built 42 files\n"
  }
}
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     1      04:01:08    needs attention (finished)
```

The repeat subscription on the child's next turn, then two daemon restarts (SIGTERM, start
again):

```
$ code-foundry thread send --id s-7754a478e649 --text 'say bye then stop'
sent to thread s-7754a478e649
$ sleep 15; code-foundry thread items --id s-867564981c98 | tail -3
#15 wake: Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
#16 claude: Thread "Say hi and stop" (s-7754a478e649) finished with status "needs_attention" (reason: finished). This is a repeat wake for the same thread, so nothing new h…
#17 turn end: success, 1.1s, 26590 in / 65 out tokens, $0.0004, $0.0044 so far, claude-haiku-5-5
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     2      04:03:00    needs attention (finished)
# restart 1
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     2      04:03:00    needs attention (finished), disconnected
$ code-foundry action add Long --command 'sleep 120' --in-terminal=false --repo e7124810184e
added action Long (a-6d35359c8859)
$ code-foundry thread subscribe --id s-867564981c98 --run r-9022511d10d1
subscribed sub-3c680df9efab: s-867564981c98 wakes when run r-9022511d10d1 finishes (once)
$ code-foundry thread subscriptions --id s-867564981c98
ID                SUBSCRIBER                    TARGET                                   UNTIL     REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled   yes     2      04:03:00    needs attention (finished), disconnected
sub-3c680df9efab  s-867564981c98 (pr4 foreman)  run r-9022511d10d1 (Long)                finished  no      0      -           running
# restart 2 (the shutdown killed the Long run; no wake for it)
$ grep "dropped wake subscriptions" daemon.log
level=INFO msg="dropped wake subscriptions at startup (action runs do not outlive the daemon; archived or removed threads)" store=thread count=1
$ code-foundry thread subscriptions --all
ID                SUBSCRIBER                    TARGET                                   UNTIL    REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-2e4a9c05f6eb  s-867564981c98 (pr4 foreman)  thread s-7754a478e649 (Say hi and stop)  settled  yes     2      04:03:00    needs attention (finished), disconnected
```

Unsubscribe, a subscribe that starts the stopped foreman, archive:

```
$ code-foundry thread subscribe --id s-867564981c98 --thread s-7754a478e649 --until error
subscribed sub-3f707c7609db: s-867564981c98 wakes when thread s-7754a478e649 has an error (once)
$ code-foundry thread unsubscribe --id s-867564981c98 --thread s-7754a478e649
removed sub-2e4a9c05f6eb: s-867564981c98 wakes when thread s-7754a478e649 is settled (repeat)
removed sub-3f707c7609db: s-867564981c98 wakes when thread s-7754a478e649 has an error (once)
$ code-foundry thread subscribe --id s-867564981c98 --thread s-7754a478e649 --repeat --json | jq -c '{id: .subscription.id, fired, existed}'
{"id":"sub-32d060b2747e","fired":true,"existed":null}
$ sleep 8; code-foundry thread items --id s-867564981c98 | grep -E '^#(1[5-9]|2[0-9]) |wake:'   # the disconnected foreman started with the wake
#5 wake: Thread s-7754a478e649 is idle: finished.
#8 wake: Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
#11 wake: Action "Slow" run r-f5aed3e9907d finished with exit 3.
#15 wake: Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
#16 claude: Thread "Say hi and stop" (s-7754a478e649) finished with status "needs_attention" (reason: finished). This is a repeat wake for the same thread, so nothing new h…
#17 turn end: success, 1.1s, 26590 in / 65 out tokens, $0.0004, $0.0044 so far, claude-haiku-5-5
#18 wake: Thread "Say hi and stop" (s-7754a478e649) is idle: finished.
#19 claude: Thread "Say hi and stop" (s-7754a478e649) finished with status "needs_attention" (reason: finished), and it is now disconnected. This is another repeat of the s…
#20 turn end: success, 1.2s, 27355 in / 63 out tokens, $0.0005, $0.0049 so far, claude-haiku-5-5
$ code-foundry thread archive --id s-7754a478e649 --archived=true
archived thread Say hi and stop (s-7754a478e649)
$ code-foundry thread subscriptions --all
no wake subscriptions
$ sqlite3 /tmp/cf-pr4/db.sqlite 'select count(*) from thread_subscriptions'
0
```

The daemon logs had no ERROR lines; each fire logged `wake subscription fired` and each
delivery `woke thread`. Then the daemon was stopped (SIGTERM) and `~/cf-scratch-pr4`,
`/tmp/cf-pr4` and the scratch threads' transcripts (`~/.claude/projects/-Users-alex-cf-scratch-pr4`)
deleted. Not exercised live: the wake limit (60 wakes; covered by the fake-clock test)
and a snoozed subscriber (Send's unsnooze, unchanged).

## Daemon restart

Needed: migration 0024, new RPCs and commands, the commit hook.

Plugins add a third target kind, their wake sources: `docs/notes/plugins-wake-sources.md`.

Wake detail (a wake per new pending request; no or stale report, last message, pending request, children in settled wakes): `docs/notes/wake-detail.md`.
