# Agents, PR 5: the CLI for agents (2026-10-17)

The last of five PRs that make threads drivable by agents from the CLI (PR 1:
`agents-1-wait-events.md`, PR 2: `agents-2-metadata.md`, PR 3: the lineage GUI, PR 4:
`agents-4-wake.md`). It closes the gaps those notes left: `thread list` filters in the
daemon, ids take a unique suffix, `thread new --request-id` is idempotent, `thread read`
pages a conversation, `thread send --wait` waits for the turn it starts, events carry a
daemon epoch, and `code-foundry guide` (which every thread's system prompt points at)
tells an agent all of it. Daemon, proto and CLI; no GUI change.

## Decisions

Agreed with Alex (the brief):

* **`thread.list` filters in the daemon**: `archived` (include archived; default they
  are left out), `all` (everything, other filters ignored except `limit`), `status`
  (busy, idle, attention, error), `state` (starting, connected, closing, disconnected),
  `repo` (id, name or path), `workspace` (id or name), `created-by` (a thread id or
  suffix, or `user`), `label` (comma list, all must match), `limit` (default 50, 0 = no
  limit); most recently active first. Text: one line per thread,
  `<id>  <status>  <name>  <project>@<branch>  <age>` and `↳ <creator>`. `--json` is the
  `ListThreadsResponse` (the retired usage ledger only with `--all`). The GUI keeps its
  snapshot stream.
* **Id suffixes**: thread, action run, subscription (and terminal) ids take the full id or
  a unique suffix of at least 4 characters; ambiguous is InvalidArgument naming the
  candidates, none is NotFound. Every id arg says so in its description.
* **`thread.new --request-id`** (at most 128 characters): a repeat within 24 hours
  returns the thread made the first time. Persisted (migration 0025).
* **`thread.read`**: `id`, `last` (default 20), `since` (item id or ordinal), `full`,
  `role` (user, assistant, tool, note, wake); the `thread.items` log format; `--json`
  the items and `nextSince`.
* **`thread.send --wait`** (with `for`, default 10m) waits for the turn the message
  starts, not for the status published before it; **`thread.wait --after`** (item id or
  ordinal) does the same for any item. Both use `thread.Meets`.
* **Daemon epoch**: `Event.epoch` and `WatchEventsRequest.since_epoch`; a mismatch falls
  back to snapshots. `events --since-epoch`.
* **`code-foundry guide`**: a local verb printing a Markdown guide generated from
  `CommandService.List` at runtime (intro, hand-written conventions, every command by
  category, "Discover more"), and one static `--append-system-prompt` line for every
  thread: "This thread runs inside code-foundry. Run `code-foundry guide` to see how to
  create, wait on, read and wake other threads from the CLI." A workspace thread's line
  follows it.
* **`thread budget -1`**: positional negative numbers now reach the command.

Decided while building (not in the brief; flagged for review):

* **Suffixes resolve in the registry, not per command.** `ArgSpec.ID` (an `IDKind`) marks
  an id arg; `Registry.Invoke` resolves it after the required check and before the
  confirmation (so a confirm message shows the full id), through the `IDLister` the
  domain registered (`RegisterThread`: threads and subscriptions, `RegisterAction`:
  runs, `RegisterTerminal`: terminals). The listers call the backends' List RPCs, so
  there is no new store method. A value with the kind's prefix (`s-`, `r-`, `sub-`, `t-`)
  or shorter than 4 characters is passed through untouched: no list call for a full id
  (the GUI's case), and the daemon answers an unknown one as before
  (`thread not found: c2`). A resolved context-bound id is overlaid onto the context
  too. `thread.list --created-by` resolves in its own Run (the literal `user`; a removed
  creator's full id still filters).
* **Negative numbers**: the CLI's parser reads `-1`, `-0.5` as words unless they follow a
  flag that takes a value (`--usd -1`). Fixed on the way: Go's flag package eats the
  `--` that ends flags, and the old loop then parsed the words after it as flags again.
* **`ListThreadsRequest.filter`** is a message: unset is the old answer (every thread in
  creation order and the ledger), so the GUI and the daemon's own callers are
  unchanged; `app restart`'s restart cost (`cmd/code-foundry/update.go`) invokes
  `thread.list` and now passes `all` and `limit=0`. Filtering is
  `thread.FilterThreads` (pure, table-tested) behind `Store.List`, which resolves the
  repo (`workspace.ResolveRepo`) and workspace refs first (unknown: InvalidArgument).
  `--status idle` is `THREAD_STATUS_IDLE` exactly: a finished turn nobody looked at is
  `attention (finished)`.
* **`thread.list` moved** to `commands_thread_list.go` with `RegisterThreadList`
  (`ThreadListDeps{Thread, Repo}`): it reads the projects for `<project>@<branch>`. The
  old table's REASON, WORKSPACE, PRS, CONTEXT and WORKTREE columns are gone (the reason
  is in the status word for attention and error, everything is in `--json`); so are
  their helpers and test. Archived and snoozed threads get `[archived]`/`[snoozed]`; an
  empty answer says archived threads were left out; a full page says how to see more.
* **Request ids are per creator** (`created_by`, or the user): two agents using the same
  key do not get each other's thread. `Store.CreateOnce` (a new method; `Create` is
  unchanged) waits for a create in flight with the same key, ignores the repeat's other
  fields, and renews an expired key. A removed thread forgets its keys (ON DELETE
  CASCADE). `CreateThreadResponse.reused` is on the RPC; `thread.new --json` stays the
  Thread (no additive field fits there without putting `reused` on every thread), and a
  reuse prints "thread … was created earlier for request id k1; nothing new started"
  and focuses nothing.
* **`thread.read` is its own command** rather than more `thread.items` args: its
  defaults differ (the last 20, not all) and so does its JSON (a page, not the snapshot
  with pending requests and agents). The daemon pages
  (`ListThreadItemsRequest.query` → `ListThreadItemsResponse.page`, `api/thread_read.go`):
  role first, then with `since` the first `last` items after it (oldest first, `more`
  when there are others, so `nextSince` pages without a gap), else the last `last`.
  `nextSince` is the page's last item, or the last before a text still streaming; the
  request's `since` when nothing is settled. `since` is an item id first, else an
  ordinal. Roles: user (not wakes), assistant (text), tool (calls, permission requests,
  questions), note, wake. The text adds `(more: --since <id> reads on)`.
* **What "after" means**: a top-level turn end, error, permission request or question
  item with a greater ordinal (a subagent's items do not count). `Wait` follows the
  thread's item events (subscribed before reading the items) alongside the thread list.
  A message queued behind a running turn is safe: that turn's end comes after it, but
  the status stays busy while Claude reports a queued turn. `send --wait` passes its
  message's item id; its `--json` is the thread, and a timeout says
  `sent to thread s-…; timed out after …`.
* **The epoch** is 12 random hex digits drawn by `NewEvents` (once per daemon), stamped
  by the hub on live events and by each stream on its snapshots and heartbeats. An
  empty `since_epoch` keeps PR 1's behaviour. The text output of `events` is unchanged;
  `--json` lines carry `epoch`.
* **The guide**: dotted names in the command list (the test checks every one is
  there), the Thread category in full (one line per arg, except the thread id every
  thread command takes and the args only the GUI sets), every other category one line
  per command with the description's first sentence; categories Thread, Action,
  Workspace, Project, Repository, Terminal, then the rest. It names the caller's own
  thread when `$CODE_FOUNDRY_THREAD` is set. **It must stay under 29,000 bytes** (a
  test): the first version was 37 KB, and Claude's Bash tool set it aside in a file, so
  the e2e agent grepped it instead of reading it. Now 27.6 KB, 274 lines.
* `ThreadPrompt` comes first, the workspace line after it (`systemPrompt`).
* Id help reads "Thread id (or a unique suffix of 4+ characters)".

## What was built

* **Proto**: `thread_lifecycle.proto`: `ListThreadsRequest.filter`, `ThreadFilter`,
  `CreateThreadRequest.request_id` (20), `CreateThreadResponse.reused`,
  `WaitThreadRequest.after`. `thread.proto`: `ListThreadItemsRequest.query`,
  `ListThreadItemsResponse.page`, `ThreadItemRole`, `ThreadItemsQuery`,
  `ThreadItemsPage`. `events.proto`: `Event.epoch` (21), `WatchEventsRequest.since_epoch`.
  Generated Go and TS committed (the frontend uses none of it).
* **Migration `0025_thread_requests.sql`**: `thread_requests(creator, request_id,
  thread_id → threads ON DELETE CASCADE, created_at)`, primary key (creator,
  request_id). `internal/db/thread_requests_migration_test.go`.
* **Store** (`internal/store/thread`): `filter.go` (new: `ListOptions`,
  `FilterThreads`, `Manager.List`), `requests.go` (new: `CleanRequestID`, `CreateOnce`,
  the table), `workspace.go` (`ThreadPrompt`, `systemPrompt`), `manager.go` (the prompt in
  `claudeCommand`, `Manager.reqs`), `thread.go` (`Store.List`, `Store.CreateOnce`),
  `threadtest/fake.go` (`List`, `CreateOnce`, `AppendItem`).
* **API** (`internal/api`): `thread_lifecycle.go` (List with a filter, Create through
  `CreateOnce`), `thread_read.go` (new: `pageItems`, `sinceOrdinal`, `roleMatches`),
  `thread.go` (ListItems pages), `thread_wait.go` (after: `reactedAfter`, `isReaction`),
  `events.go`, `events_hub.go` (the epoch).
* **Commands** (`internal/command`): `resolve.go` (new: `IDKind`, `ResolveID`,
  `SetIDLister`, the listers), `registry.go` (resolution in Invoke), `args.go`
  (`ArgSpec.ID`), `commands_thread_list.go` (new), `commands_thread_read.go` (new),
  `commands_thread_wait.go` (`after`, `waitLimit`, `waitThread`), `commands_thread.go`
  (`send --wait`, `thread.read`), `commands_thread_lifecycle.go` (`--request-id`, list
  moved out), id specs in the thread, mcp, agents, slash, subscribe, usage, terminal,
  ui and action files, `all/all.go`.
* **CLI** (`cmd/code-foundry`): `guide.go` (new), `confirm.go` (negative numbers, `--`),
  `events.go` (`--since-epoch`), `main.go` (the verb), `update.go` (restart cost).
* `docs/ARCHITECTURE.md`: sections 4, 6 and 7.

## Tests

* `command`: `resolve_test.go` (ResolveID table, Invoke resolution and context overlay,
  a failing lister, no lister, ArgSpec validation), `commands_thread_list_test.go`
  (filter mapping, lines, hints, created-by suffix), `commands_thread_read_test.go`,
  `commands_thread_request_test.go`, `commands_thread_wait_test.go`
  (`TestThreadWaitAfterMessage`: send --wait and wait --after through the busy status
  and a subagent's turn end; errors and timeouts).
* `store/thread`: `filter_test.go` (FilterThreads table, ref resolution),
  `requests_test.go` (repeat, other creator, no key, too long, restart, expiry, remove,
  four concurrent creates making one thread), `prompt_test.go`, `workspace_test.go`
  (the argv of project and workspace threads).
* `api`: `thread_list_test.go` (filter, ledger, mapping, request id),
  `thread_read_test.go` (the page table).
* `cmd`: `guide_test.go` (every command named, under 400 lines and 29,000 bytes, the
  hand-written parts), `positional_test.go`, `events_test.go` (epoch on every line,
  resume with and without it, another epoch gets the snapshot).

## Gotchas

* `TestRunEvents` failed about half the time on main itself (`-count=20`: 12 of 20): the
  repo and thread-list topics race to the hub, so the three events can be numbered in
  any order, and the test assumed one. It now compares the replay with the lines of the
  events after the lowest seq, whatever they are.
* Claude records the system prompt on a conversation's first request and reuses it on
  resume (`--system-prompt-snapshot`), so threads that exist already keep their old one
  (none, for a project thread) until a compaction; new threads get the line.
* `thread wait` right after `thread new` does wait: the new thread is STARTING. The race
  is only after a send to a thread that already finished a turn (shown below).
* A tool call `thread read` returned while running gets its result later, at an ordinal
  `nextSince` has passed; read from an earlier `since` (or `thread items`) to see it.
  Only streaming text holds `nextSince` back, so a long subagent run cannot stall paging.
* The event hub starts with the first `events` (or GUI) stream: changes before that are
  not numbered (PR 1's design), which is why the e2e below makes its changes after.
* The worktree-isolation hook refused command lines with backslash escapes or `--`
  flags inside heredocs; the e2e ran from scripts written to `/tmp/pr5-e2e` and a
  wrapper `cf` (the branch binary with `CODE_FOUNDRY_HOME=/tmp/cf-pr5`).

## End to end (2026-10-17, isolated home, scratch repo under ~)

`make build`; the daemon `CODE_FOUNDRY_HOME=/tmp/cf-pr5 bin/code-foundry daemon --dev`
with the branch's `bin` first on `PATH` (so a thread's `code-foundry` is this build) and
no `CODE_FOUNDRY_*` variables; `~/cf-scratch-pr5` with a README, registered
(`f1fc8957b4d2`) and `repo.git.init`ed. `code-foundry` below is the wrapper. Model
`claude-haiku-5-5[1m]`, effort medium. Three threads: "pr5 parent" (by the user,
labels e2e), "pr5 child" (`--created-by` the parent, brief greet, labels child,e2e) and
"pr5 archived" (archived after its turn). Output as printed.

```
$ code-foundry thread list
s-388ece239757  attention (finished)  pr5 child   cf-scratch-pr5@main  7s  ↳ pr5 parent
s-8e83e41e18c2  attention (finished)  pr5 parent  cf-scratch-pr5@main  7s
$ code-foundry thread list --archived
s-fcb3f71cb795  attention (finished)  pr5 archived  cf-scratch-pr5@main  6s  [archived]
s-388ece239757  attention (finished)  pr5 child     cf-scratch-pr5@main  7s  ↳ pr5 parent
s-8e83e41e18c2  attention (finished)  pr5 parent    cf-scratch-pr5@main  7s
$ code-foundry thread list --status attention
s-388ece239757  attention (finished)  pr5 child   cf-scratch-pr5@main  7s  ↳ pr5 parent
s-8e83e41e18c2  attention (finished)  pr5 parent  cf-scratch-pr5@main  7s
$ code-foundry thread list --status busy
no threads (archived threads are left out; --archived includes them)
$ code-foundry thread list --created-by e41e18c2
s-388ece239757  attention (finished)  pr5 child  cf-scratch-pr5@main  7s  ↳ pr5 parent
$ code-foundry thread list --created-by user
s-8e83e41e18c2  attention (finished)  pr5 parent  cf-scratch-pr5@main  8s
$ code-foundry thread list --label child
s-388ece239757  attention (finished)  pr5 child  cf-scratch-pr5@main  7s  ↳ pr5 parent
$ code-foundry thread list --label child,nope
no threads (archived threads are left out; --archived includes them)
$ code-foundry thread list --limit 1
s-388ece239757  attention (finished)  pr5 child  cf-scratch-pr5@main  7s  ↳ pr5 parent
(the 1 most recently active; --limit 0 lists all)
$ code-foundry thread list --repo nope
code-foundry thread.list: invalid argument: no repo "nope"
Run `code-foundry help thread.list` for usage.
exit=2
$ code-foundry thread list --json | jq -c '{threads: [.threads[].id]}'
{"threads": ["s-388ece239757", "s-8e83e41e18c2"]}
$ code-foundry thread get 239757
thread pr5 child (s-388ece239757)
status: needs attention (finished)
worktree: /Users/alex/cf-scratch-pr5
created by: pr5 parent (s-8e83e41e18c2)
brief: greet
labels: child, e2e
cost: $0.0021
$ code-foundry thread get e649zz
code-foundry thread.get: no thread id ends in "e649zz"
Run `code-foundry help thread.get` for usage.
exit=2
```

Request ids:

```
$ code-foundry thread new --repo f1fc8957b4d2 --model 'claude-haiku-5-5[1m]' --effort medium --request-id k1 --name "pr5 request" --prompt "say yes then stop"
created thread pr5 request (s-0090d0ae3c16) in /Users/alex/cf-scratch-pr5
$ code-foundry thread new --repo f1fc8957b4d2 --model 'claude-haiku-5-5[1m]' --effort medium --request-id k1 --name "pr5 request again" --prompt "say no then stop"
thread pr5 request (s-0090d0ae3c16) in /Users/alex/cf-scratch-pr5 was created earlier for request id k1; nothing new started
$ code-foundry thread new --request-id k1 … --json | jq -c '{id, name}'
{"id": "s-0090d0ae3c16", "name": "pr5 request"}
$ code-foundry thread list --all --limit 0 | grep -c 'pr5 request'
1
$ sqlite3 /tmp/cf-pr5/db.sqlite 'select creator, request_id, thread_id from thread_requests'
|k1|s-0090d0ae3c16
```

Reading:

```
$ code-foundry thread items --id s-388ece239757
#1 note: Created by pr5 parent · brief: greet
#2 you: say hello then stop
#3 claude: Hello!
#4 turn end: success, 1.6s, 22384 in / 6 out tokens, $0.0021, $0.0021 so far, claude-haiku-5-5
$ code-foundry thread read s-388ece239757 --last 3
#2 you: say hello then stop
#3 claude: Hello!
#4 turn end: success, 1.6s, 22384 in / 6 out tokens, $0.0021, $0.0021 so far, claude-haiku-5-5
$ code-foundry thread read s-388ece239757 --since 1 --last 2
#2 you: say hello then stop
#3 claude: Hello!
(more: --since msg_011Cg7bnhozkjY2g4RPi24AJ/0 reads on)
$ code-foundry thread read s-388ece239757 --since 1 --last 2 --json | jq -c '{items: [.items[].ordinal], nextSince, more}'
{"items": ["2", "3"], "nextSince": "msg_011Cg7bnhozkjY2g4RPi24AJ/0", "more": true}
$ code-foundry thread read s-388ece239757 --since msg_011Cg7bnhozkjY2g4RPi24AJ/0
#4 turn end: success, 1.6s, 22384 in / 6 out tokens, $0.0021, $0.0021 so far, claude-haiku-5-5
$ code-foundry thread read s-388ece239757 --since msg_011Cg7bnhozkjY2g4RPi24AJ/0 --json
{"threadId":"s-388ece239757", "items":[{"id":"turn-361a7b4f-419d-48c6-8f88-384e0f204592", "ordinal":"4", …, "turnEnd":{…}}], "nextSince":"turn-361a7b4f-419d-48c6-8f88-384e0f204592"}
$ code-foundry thread read s-388ece239757 --role assistant
#3 claude: Hello!
```

(An unknown `--since` then read "thread not found: the thread has no item nope"; it is a
plain NotFound now, "the thread has no item nope (give an item id or an ordinal)".)

Sending and waiting:

```
$ time code-foundry thread send --id s-388ece239757 "Use your Bash tool to run: sleep 8. Then reply with the single word done." --wait --for 3m
thread s-388ece239757 pr5 child: needs attention (finished)
(send --wait took 12 s)
$ code-foundry thread read s-388ece239757 --last 4
#5 you: Use your Bash tool to run: sleep 8. Then reply with the single word done.
#6 tool Bash [done] {"command":"sleep 8","description":"Sleep for 8 seconds"}
    → (Bash completed with no output)
#7 claude: done
#8 turn end: success, 12.0s, 49027 in / 85 out tokens, $0.0022, $0.0043 so far, claude-haiku-5-5
$ code-foundry thread send --id s-388ece239757 "Use your Bash tool to run: sleep 6. Then reply with the single word again."
sent to thread s-388ece239757
$ code-foundry thread wait s-388ece239757 --after 1a38042e-2aea-40e8-afc6-c600237bcee1 --for 3m      # the message's item
thread s-388ece239757 pr5 child: needs attention (finished)
(send then wait --after took 9 s)
$ code-foundry thread send --id s-388ece239757 "say ok" --wait --for 1ms
code-foundry: thread.send: sent to thread s-388ece239757; timed out after 1ms waiting for thread s-388ece239757 to be idle; it is needs attention (finished) (deadline_exceeded)
exit=1
$ code-foundry thread budget -1 --id s-388ece239757
code-foundry thread.budget: "-1" is not an amount in USD (5, 5.00, 0.25; 0 for none)
exit=2
```

The old race, for contrast (a plain wait after a send):

```
$ code-foundry thread send --id s-388ece239757 "Use your Bash tool to run: sleep 6. Then reply with the single word third."
sent to thread s-388ece239757
$ code-foundry thread wait s-388ece239757 --for 3m
thread s-388ece239757 pr5 child: needs attention (finished)
(send then a plain wait took 0 s)
```

Events, then a daemon restart (SIGTERM, the rebuilt binary started again):

```
$ (sleep 6 | code-foundry events --json --source thread-list > a.jsonl) &
$ code-foundry thread label --id s-388ece239757 --add one; code-foundry thread label --id s-388ece239757 --add two
$ jq -c '{epoch, seq, labels: .threadList.updated.labels}' a.jsonl
{"epoch": "26eba4f98576", "seq": null, "labels": null, "snapshot": true}
{"epoch": "26eba4f98576", "seq": "2", "labels": ["child", "e2e", "one", "seen"], "snapshot": false}
{"epoch": "26eba4f98576", "seq": "4", "labels": ["child", "e2e", "one", "seen", "two"], "snapshot": false}
$ sleep 2 | code-foundry events --source thread-list --since 2 --since-epoch 26eba4f98576
4 thread-list updated s-388ece239757: needs attention (finished)
# restart
$ sleep 1 | code-foundry events --json --source thread-list | head -1 | jq -c '{epoch, snapshot}'
{"epoch": "fc685e124c73", "snapshot": true}
(three label changes, now that the new daemon's hub numbers events)
$ sleep 2 | code-foundry events --source thread-list --since 2 --since-epoch 26eba4f98576      # the old daemon's epoch
- thread-list snapshot
$ sleep 2 | code-foundry events --source thread-list --since 2                           # no epoch: seq alone
3 thread-list updated s-388ece239757: needs attention (finished)
```

The guide, and a thread asked about it:

```
$ code-foundry guide | head -16
# code-foundry: a guide for agents

code-foundry runs Claude Code threads (conversations like this one) in git worktrees, from a daemon on this Mac;
a GUI shows them to the user. The `code-foundry` CLI drives the daemon: create threads, wait for them, read
what they did, be woken when they finish, run project actions.

- Inside a thread, `$CODE_FOUNDRY_THREAD` is that thread's id.
  It is the default for `--id` ("the thread" of thread commands), for `--context-thread`, and for
  `thread new --created-by` (pass `--created-by=` to opt out).
- Invoke a command by its dotted name or with spaces: `code-foundry thread.new ...` = `code-foundry thread new ...`.
  `<arg>` below is positional; every other arg is a `--flag`.
- Every command takes `--json` for a structured answer (protobuf JSON, camelCase fields).
- Ids (threads `s-...`, action runs `r-...`, subscriptions `sub-...`, terminals `t-...`) may be given as a unique
  suffix of at least 4 characters: `code-foundry thread get 8f3a`.
- Exit status: 0 done, 1 failed or timed out, 2 a usage mistake or a refusal (the message says why).
$ code-foundry guide | wc -l
     273
$ code-foundry thread new --repo f1fc8957b4d2 --model 'claude-haiku-5-5[1m]' --effort medium --name "pr5 guide" --created-by= --prompt 'run `code-foundry guide` and tell me in one sentence what thread wait does'
$ code-foundry thread wait s-d34b88d2d00a --for 4m
thread s-d34b88d2d00a pr5 guide: needs attention (finished)
$ code-foundry thread read s-d34b88d2d00a --last 6
#1 you: run `code-foundry guide` and tell me in one sentence what thread wait does
#2 tool Bash [done] {"command":"code-foundry guide","description":"Show code-foundry CLI guide"}
    → # code-foundry: a guide for agents …
#3 thinking
#4 claude: `code-foundry thread wait <id>` blocks until the thread is idle, needs attention, has an error, or is disconnected (default idle), returning at once if it alrea…
#5 turn end: success, 4.1s, 56889 in / 314 out tokens, $0.0030, $0.0030 so far, claude-haiku-5-5
$ code-foundry thread read s-d34b88d2d00a --role assistant --full
#4 claude: `code-foundry thread wait <id>` blocks until the thread is idle, needs attention, has an error, or is disconnected (default idle), returning at once if it already is, and exits 1 if the `--for` time limit runs out.
$ code-foundry thread items --id s-d34b88d2d00a --full | grep 'You are thread'
- You are thread `s-d34b88d2d00a` (`$CODE_FOUNDRY_THREAD`).
# daemon.log, the thread's argv:
… --append-system-prompt This thread runs inside code-foundry. Run `code-foundry guide` to see how to create, wait on, read and wake other threads from the CLI.
```

With the first (37 KB) guide the same question's Bash output came back as
`<persisted-output>` and the agent grepped the file for "thread wait"; it still answered
right, but that is why the size test exists.

The daemon logs had no ERROR or WARN lines. Then the daemon was stopped (SIGTERM) and
`~/cf-scratch-pr5`, `/tmp/cf-pr5` and the scratch threads' transcripts
(`~/.claude/projects/-Users-alex-cf-scratch-pr5`) deleted.

## Daemon restart

Needed: migration 0025, new RPC fields and commands, the system prompt line, the epoch.
