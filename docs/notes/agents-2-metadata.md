# Agents, PR 2: thread metadata for agent-created threads (2026-10-17)

The second of five PRs that make the daemon drivable by agents that create and supervise
other threads from the CLI (PR 1: `agents-1-wait-events.md`). A thread now records who
created it and why (`created_by`, `created_by_name`, `brief`), carries labels, the
latest report of its agent (`report_*`) and a spending limit (`budget_usd`) that
interrupts Claude when the thread's cost reaches it. Every change publishes the thread on
the thread list, so the GUI, `thread wait` and `code-foundry events` see it. No GUI
component yet: PR 3 uses the view model fields added here.

## Decisions

Agreed with Alex (the brief):

* **`created_by` / `created_by_name`.** The id of the thread whose agent ran
  `thread new`, empty when the user made it, and that thread's display name at creation
  (its id when unnamed), kept verbatim when the creator is renamed, archived or removed.
  Set through `thread.new`'s `created-by` arg, which the GUI never passes and the CLI
  defaults to `$CODE_FOUNDRY_THREAD` (an empty `--created-by=` opts out). It is never
  taken from `Context.ActiveThreadID`: the GUI sends the thread the user is viewing as
  the active thread. The creator must exist (InvalidArgument). `thread.fork` keeps
  `parent_id` and does not set it.
* **The "Created by" note.** Create writes a `note` item `note-created-by` as the new
  thread's first item, before the first message: `Created by <name> · brief: <brief>`
  (no brief part when empty). The GUI renders it as any note (unstyled; PR 3 restyles).
* **`brief`**: trimmed, at most 500 runes, verbatim, no default from the prompt.
* **`labels`**: tokens of `a-z 0-9 - _ . /`, 1 to 40 runes, deduplicated and sorted;
  `thread.new --labels a,b` and `thread.label --add/--remove/--clear`.
* **The report**: `report_status` (unspecified, done, blocked, failed, progress),
  `report_summary` (at most 1000 runes), `report_data` (a JSON object, at most 16 KiB),
  `report_at`. `thread.report <status> [summary] [--data]`, id context-bound so an agent
  reports on its own thread by default. A new report replaces the previous one.
* **`budget_usd`** (REAL / double, 0 = none): `thread.new --budget` and
  `thread.budget <usd>`. When the thread's cost first reaches it while the thread is
  connected and Claude works, the daemon interrupts the turn, sets NEEDS_ATTENTION
  `budget reached` (listed in the proto's `status_reason` comment), appends the note
  "Budget of $X reached; Claude was interrupted. Raise it with `code-foundry thread
  budget`." and logs at info. Once per crossing; raising the budget above the cost
  re-arms it. Sends stay allowed.
* `thread.list`'s text output is unchanged (PR 5 reworks it); `--json` carries every
  field.

Decided while building (not in the brief; flagged for review):

* **A new `thread.get` command** (NoKeybinding). The brief's e2e calls
  `thread.get --json`, which did not exist (`thread.focus` only emits a UI intent and
  prints `delivered=N`; it is unchanged). `thread get <id>` prints one `key: value` line
  per fact (status, worktree, created by, forked from, brief, labels, report, report
  data, cost and budget); `--json` is the full `Thread`.
* **Three new unary RPCs**, `ThreadService.Label`, `Report`, `SetBudget`, since commands
  only talk to Connect-shaped backends. Label edits atomically in the store (clear, then
  remove, then add) so two agents labelling at once never lose an edit; a label in both
  add and remove is InvalidArgument.
* **Labels are lowercased** before validation (`Feature` becomes `feature`) and capped
  at 32 per thread. Whitespace inside a label is refused, not slugged.
* **`report_data` is stored compacted** (`json.Compact`), and the 16 KiB limit applies to
  the compacted form, so a pretty-printed `@file.json` is not penalized for its
  indentation. `null`, arrays, strings and trailing garbage are refused.
* **CLI `@file` and `-`**: generic `ArgSpec` flags rather than a special case:
  `default_to_thread_env` (proto field 9; `created-by`) and `file_or_stdin` (field 10;
  `thread.report --data`). The CLI reads `@path` relative to its cwd and `-` from stdin
  (bounded at 1 MiB); the daemon never reads files for it. Claude's Bash tool has
  `/dev/null` as stdin, so `-` there is an empty value ("must be a JSON object").
* **The budget marker is persisted**: `budget_hit_usd`, the budget value the stop last
  fired for (0 = armed). It fires while `budget_hit_usd != budget_usd`, so a daemon
  restart does not fire it again. `SetBudget` resets it to 0 when the new budget is 0
  or above the cost (re-armed); a budget set at or under the cost keeps the marker, and a
  value it never fired for fires on the next priced response while Claude works (an
  agent lowering a budget under the cost means "stop now"). It is not on the API.
* **When the check runs**: after every usage publish of a connected thread's runner
  (`publishUsage`, at most once per transcript poll with a new priced API response), and
  only while Claude works (`busy` or compacting, not closing, not mid effort-restart).
  A budget lowered under the cost of an idle thread therefore fires on its next turn's
  first response, not at once. Cost is `UsageCost` of the thread's usage: the same fold
  and rates as `cost_usd` and `usage.show --thread`, subagent runs included, unpriced
  buckets counted 0.
* **How long "budget reached" lasts** (`streamStatus.budget`): it outranks busy (the
  interrupt is in flight) but not a pending permission prompt or question. The next
  message clears it; so does a turn Claude starts by itself after the stopped one ended,
  and, once the stopped turn ended, a viewer (like "finished" and "error: <code>"). A
  thread that idles out keeps it as its disconnected status, persisted. `thread wait`'s
  `idle` counts it as idle (it is NEEDS_ATTENTION for something other than a prompt or
  question), so a parent waiting on a child over budget is released.
* **A fork copies none of the metadata** (brief, labels, report, budget): it starts
  fresh. It does copy the parent's items, so a fork of an agent-made thread starts with
  the parent's "Created by" note in its copied history.
* `thread.label`, `thread.budget` are bindable; `thread.get` and `thread.report` are
  NoKeybinding (a query that prints, an agent's verb).

## What was built

* **Migration `0023_thread_metadata.sql`**: ten `ALTER TABLE threads ADD COLUMN`s,
  each `NOT NULL` with a default, so existing rows get no metadata: `created_by`,
  `created_by_name`, `brief` (TEXT ''), `labels` (TEXT `'[]'`, a JSON array),
  `report_status` (INTEGER 0, mirrors `ThreadReportStatus`), `report_summary`,
  `report_data` (TEXT ''), `report_at` (INTEGER unix ms, 0), `budget_usd`,
  `budget_hit_usd` (REAL 0; the table is STRICT, REAL keeps $0.0001 exactly as a
  double). No foreign key on `created_by`: the creator may be removed.
  `internal/db/thread_metadata_migration_test.go` migrates a pre-0023 row.
* **`proto/codefoundry/v1/thread_lifecycle.proto`**: `Thread` fields 43 to 51,
  `enum ThreadReportStatus`, `CreateThreadRequest` fields 15 to 18,
  `LabelThreadRequest/Response`, `ReportThreadRequest/Response`,
  `SetThreadBudgetRequest/Response`. `thread.proto`: `rpc Label`, `Report`, `SetBudget`.
  `command.proto`: `ArgSpec.default_to_thread_env`, `file_or_stdin`. Generated Go and TS
  committed.
* **Store** (`internal/store/thread`):
  * `thread.go`: `Thread.CreatedBy/CreatedByName/Brief/Labels/Report/BudgetUSD/
    BudgetHitUSD`, `CreateOptions.CreatedBy/Brief/Labels/BudgetUSD`, `Store.Label/
    Report/SetBudget`.
  * `metadata.go` (new): limits, `ReportStatus`, `Report`, the exported pure validators
    (`CleanBrief`, `CleanLabel(s)`, `EditLabels`, `CleanReport`, `CheckBudget`; the fake
    reuses them), `UsageCost`, `FormatUSD`, `creator`, `startNote` and the three Manager
    methods (each validates, commits under `m.mu`, logs at info).
  * `manager.go` `Create`: validates the metadata and resolves the creator's name before
    anything is made (a refused create leaves no worktree or row), then, for an
    agent-made thread, appends the note to the new thread's log before `spawn` (the
    first message is recorded once Claude answers its handshake, so the note is
    ordinal 1) and saves its row after `spawn` wrote the thread's (`thread_items`
    references `threads`), like a fork's copy.
  * `budget.go` (new): `crossBudget` (the decision under `m.mu`, persisted), the
    runner's `checkBudget` (status, note, interrupt off the runner goroutine with
    `streamControlTimeout`, like `beginClose`), `ReasonBudgetReached`.
  * `runner.go`: `publishUsage` calls `checkBudget` after `setUsage`.
  * `stream_status.go`: `budget`/`budgetEnded`, `turnStarted`, the `Status` case.
  * `db.go`: the columns in `saveThread`/`loadThreads`, `labelsJSON`/`parseLabels`.
  * `threadtest/metadata.go` (new) and `fake.go`'s Create: the fake mirrors validation
    and records calls (`Label <id> add=… remove=… clear=…`, `Report <id> <status>
    <summary>`, `SetBudget <id> <usd>`; Create gains ` created-by=`, ` brief=`,
    ` labels=`, ` budget=`). It writes no note.
* **API** (`internal/api`): `thread_metadata.go` (new): `metadataToProto` (called from
  `threadToProto`) and the three handlers; `thread_lifecycle.go` maps the Create fields;
  `command.go` maps the two ArgSpec flags.
* **Commands** (`internal/command`): `commands_thread_metadata.go` (new): `thread.get`,
  `thread.label`, `thread.report`, `thread.budget`, `MetadataBackend` (embedded in
  `ThreadBackend`), `parseUSD` (`5`, `5.00`, `$0.25`), `formatBudget`.
  `commands_thread_lifecycle.go`: `thread.new`'s `created-by`, `brief`, `labels`,
  `budget` and the four registrations. `args.go`: `ArgSpec.DefaultToThreadEnv`
  (String, no Context, no Default) and `FileOrStdin` (String), validated at Register.
  `commandtest/thread_metadata.go` (new).
* **CLI** (`cmd/code-foundry`): `registry.go` fills a `default_to_thread_env` flag from
  `cl.threadEnv()` when not given and resolves `file_or_stdin` values;
  `argsource.go` (new) reads them.
* **GUI view model only** (`gui/frontend/src/api/threads.ts`): `ThreadView.createdBy`,
  `createdByName`, `brief`, `labels`, `report: ThreadReportView | null` (`status`,
  `summary`, `data`, `atMs`), `budgetUsd`. `stores/threads.ts`' `sameThread` compares
  labels and the report by content (every Updated event carries new arrays and
  objects; without it an identical update replaced the thread and re-rendered).

## Gotchas

* `thread wait` right after `thread send` can return at once: the thread still reads
  "finished" from its previous turn until the daemon publishes the new turn's busy
  status (step 4 below; a second wait a moment later waited for the turn). A PR 1
  matter, noted for PR 5's supervision helpers: wait on a status change, or check
  `status_changed_at` against the send.
* A negative budget given positionally (`thread budget -1`) is read as an unknown flag by
  the CLI's flag parser; `--usd=-1` reaches the validation ("not an amount in USD").
* The worktree-isolation hook of the agent session refused command lines whose prompt
  text it could not parse, and some heredocs; the e2e ran from small shell scripts with
  the prompts in files (`--prompt "$(cat …)"`).
* `budget_usd` prints as `null` in `--json` when 0 (protojson omits zero scalars), like
  every other zero field.

## Tests

* Store: `metadata_test.go`: tables for `CleanLabels`, `EditLabels`, `CleanReport`,
  brief/budget/`FormatUSD`/note text; Create records the metadata and the note first
  (before the first message, ordinal 1), the name kept across a rename, an unnamed
  creator named by its id, no note for a user's thread, refused creates leave nothing,
  all persisted across a restart; Fork sets none of it; Label/Report/SetBudget, events
  and persistence; `TestBudgetStop` (fake claude on `interrupt-pending`: no interrupt
  under the budget, one interrupt and the note over it, "budget reached" after the
  turn, no second interrupt after a send, marker kept under the cost and reset above
  it, persisted); `TestBudgetStatus` (the status table). Migration test in `internal/db`.
* API: `thread_metadata_test.go` (mapping both ways, Create fields, error codes, calls).
* Commands: `commands_thread_metadata_test.go` (thread.new's args, never the context
  thread as creator, budgets, label/report/budget/get messages and requests, argument
  errors without backend calls); registry and NoKeybinding lists; ArgSpec validation.
* CLI: `argsource_test.go` (created-by from the env, explicit wins, `--created-by=`
  opts out, `--data` as given, `@file` relative to the cwd, `-` from stdin, a missing
  file).
* Frontend: `api/threadMetadata.test.ts`, `stores/threads.test.ts` (content compare).

## End to end (2026-10-17, isolated home, scratch repo under ~)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr2 bin/code-foundry daemon --dev` (none of the
`CODE_FOUNDRY_*` variables in its environment); a folder `~/cf-scratch-pr2` with a
README. Every command below is `bin/code-foundry` with `CODE_FOUNDRY_HOME=/tmp/cf-pr2`.
The parent's prompt names this branch's binary by its absolute path (the installed
`code-foundry` on PATH is an older release whose CLI does not send `created-by`). Model
`claude-haiku-5-5[1m]`, effort medium. Output as printed.

```
$ code-foundry repo add ~/cf-scratch-pr2
registered cf-scratch-pr2 (559cd4a5f4c7)
$ code-foundry repo.git.init --repo 559cd4a5f4c7
initialized git in cf-scratch-pr2 on main
$ cat parent-prompt.txt
Use your Bash tool to run exactly this one command and nothing else: …/bin/code-foundry thread new --repo 559cd4a5f4c7 --model 'claude-haiku-5-5[1m]' --effort medium --brief "greet and stop" --labels test --prompt "say hi and stop"
Then reply with the single word done.
$ code-foundry thread.new --repo 559cd4a5f4c7 --model 'claude-haiku-5-5[1m]' --effort medium --name "pr2 parent" --prompt "$(cat parent-prompt.txt)"
created thread pr2 parent (s-eac247fce3e0) in /Users/alex/cf-scratch-pr2
$ code-foundry thread wait s-eac247fce3e0 --for 3m
thread s-eac247fce3e0 pr2 parent: needs attention (finished)
$ code-foundry thread items --id s-eac247fce3e0
#1 you: Use your Bash tool to run exactly this one command and nothing else: /Users/alex/projects/code-foundry/.claude/worktrees/agent-adde4d0f58f5a09a1/bin/code-foundr…
#2 thinking
#3 tool Bash [done] {"command":"/Users/alex/projects/code-foundry/.claude/worktrees/agent-adde4d0f58f5a09a1/bin/code-foundry thread new --repo 559cd4a5f4c7 --model 'claude-haiku-5-…
    → created thread s-7a9443998f23 in /Users/alex/cf-scratch-pr2
#4 claude: done
#5 turn end: success, 3.4s, 47289 in / 280 out tokens, $0.0029, $0.0029 so far, claude-haiku-5-5
$ code-foundry thread list                                  # text output unchanged
ID              NAME             STATUS           REASON    WORKSPACE  PRS  CONTEXT                       WORKTREE
s-eac247fce3e0  pr2 parent       needs_attention  finished  -          -    24.8K · cache expires in 1 h  /Users/alex/cf-scratch-pr2
s-7a9443998f23  Say hi and stop  needs_attention  finished  -          -    22.3K · cache expires in 1 h  /Users/alex/cf-scratch-pr2

$ code-foundry thread get s-7a9443998f23 --json | jq -c '{id, name, createdBy, createdByName, brief, labels, budgetUsd}'
{"id":"s-7a9443998f23","name":"Say hi and stop","createdBy":"s-eac247fce3e0","createdByName":"pr2 parent","brief":"greet and stop","labels":["test"],"budgetUsd":null}
$ code-foundry thread items --id s-7a9443998f23
#1 note: Created by pr2 parent · brief: greet and stop
#2 you: say hi and stop
#3 claude: Hi! Stopping here as you asked.
#4 turn end: success, 1.1s, 22326 in / 16 out tokens, $0.0016, $0.0016 so far, claude-haiku-5-5
$ code-foundry thread report done "all good" --data '{"n":1}' --id s-7a9443998f23
reported done on thread Say hi and stop (s-7a9443998f23): all good
$ code-foundry thread label --add x --remove test --id s-7a9443998f23
labels of thread Say hi and stop (s-7a9443998f23): x
$ code-foundry thread label --add 'Bad Label' --id s-7a9443998f23
code-foundry thread.label: invalid argument: label "bad label" may only have lowercase letters, digits, -, _, . and /
Run `code-foundry help thread.label` for usage.
exit=2
$ code-foundry thread report done --data '[1]' --id s-7a9443998f23
code-foundry thread.report: invalid argument: report data must be a JSON object
Run `code-foundry help thread.report` for usage.
exit=2
$ code-foundry thread new --repo 559cd4a5f4c7 --created-by s-nope --prompt hi
code-foundry thread.new: invalid argument: created by s-nope: no such thread
Run `code-foundry help thread.new` for usage.
exit=2
$ code-foundry thread get s-7a9443998f23
thread Say hi and stop (s-7a9443998f23)
status: needs attention (finished)
worktree: /Users/alex/cf-scratch-pr2
created by: pr2 parent (s-eac247fce3e0)
brief: greet and stop
labels: x
report: done: all good (2026-10-17 03:21:58)
report data: {"n":1}
cost: $0.0016
$ code-foundry thread get s-7a9443998f23 --json | jq -c '{labels, reportStatus, reportSummary, reportData, reportAt}'
{"labels":["x"],"reportStatus":"THREAD_REPORT_STATUS_DONE","reportSummary":"all good","reportData":"{\"n\":1}","reportAt":"2026-10-17T08:21:58.060Z"}
```

The child reports on itself (no `--id`: its CLI's `--context-thread` is
`$CODE_FOUNDRY_THREAD`):

```
$ cat child-prompt.txt
Use your Bash tool to run exactly this one command and nothing else: …/bin/code-foundry thread report done "reported by myself" --data '{"self":true}'
Then reply with the single word done.
$ code-foundry thread send --id s-7a9443998f23 --text "$(cat child-prompt.txt)"
sent to thread s-7a9443998f23
$ code-foundry thread wait s-7a9443998f23 --for 3m        # returned at once: still "finished" (Gotchas)
thread s-7a9443998f23 Say hi and stop: needs attention (finished)
$ sleep 15; code-foundry thread wait s-7a9443998f23 --for 3m
thread s-7a9443998f23 Say hi and stop: needs attention (finished)
$ code-foundry thread items --id s-7a9443998f23 | tail -3
#7 tool Bash [done] {"command":"/Users/alex/projects/code-foundry/.claude/worktrees/agent-adde4d0f58f5a09a1/bin/code-foundry thread report done \"reported by myself\" --data '{\"se…
    → reported done on thread Say hi and stop (s-7a9443998f23): reported by myself
#8 claude: done
$ code-foundry thread get s-7a9443998f23 --json | jq -c '{reportStatus, reportSummary, reportData}'
{"reportStatus":"THREAD_REPORT_STATUS_DONE","reportSummary":"reported by myself","reportData":"{\"self\":true}"}
```

The budget stop (`--created-by=` opts out, though this shell has no
`CODE_FOUNDRY_THREAD` anyway):

```
$ cat budget-prompt.txt
Use your Bash tool three times, one call after the other (never in parallel): first run sleep 4, then run sleep 4 again, then run sleep 4 a third time. After the third, reply with the single word done.
$ code-foundry thread new --repo 559cd4a5f4c7 --model 'claude-haiku-5-5[1m]' --effort medium --name "pr2 budget" --budget 0.0001 --created-by= --prompt "$(cat budget-prompt.txt)"
created thread pr2 budget (s-42525093b9c4) in /Users/alex/cf-scratch-pr2
$ code-foundry thread wait s-42525093b9c4 --for 3m
thread s-42525093b9c4 pr2 budget: needs attention (budget reached)
$ code-foundry thread get s-42525093b9c4 --json | jq -c '{status, statusReason, state, budgetUsd, costUsd, createdBy}'
{"status":"THREAD_STATUS_NEEDS_ATTENTION","statusReason":"budget reached","state":"THREAD_STATE_CONNECTED","budgetUsd":0.0001,"costUsd":0.0016186400000000002,"createdBy":null}
$ code-foundry thread items --id s-42525093b9c4
#1 you: Use your Bash tool three times, one call after the other (never in parallel): first run sleep 4, then run sleep 4 again, then run sleep 4 a third time. After th…
#2 tool Bash [error] {"command":"sleep 4","description":"Sleep 4 seconds (first)"}
    → The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP wha…
#3 note: Budget of $0.0001 reached; Claude was interrupted. Raise it with `code-foundry thread budget`.
#4 turn end: error_during_execution, 1.8s, 22385 in / 84 out tokens, $0.0016, $0.0016 so far, claude-haiku-5-5 (interrupted)
# daemon log: level=INFO msg="budget reached; interrupting the turn" store=thread thread=s-42525093b9c4 budget_usd=0.0001 cost_usd=0.0016186400000000002
$ code-foundry thread budget 5 --id s-42525093b9c4
budget of thread pr2 budget (s-42525093b9c4): $5.00 (spent $0.0016)
$ code-foundry thread budget 0 --id s-42525093b9c4
removed the budget of thread pr2 budget (s-42525093b9c4) (spent $0.0016)
$ code-foundry thread list
ID              NAME             STATUS           REASON          WORKSPACE  PRS  CONTEXT                          WORKTREE
s-eac247fce3e0  pr2 parent       needs_attention  finished        -          -    24.8K · cache expires in 59 min  /Users/alex/cf-scratch-pr2
s-7a9443998f23  Say hi and stop  needs_attention  finished        -          -    24.8K · cache expires in 1 h     /Users/alex/cf-scratch-pr2
s-42525093b9c4  pr2 budget       needs_attention  budget reached  -          -    22.5K · cache expires in 1 h     /Users/alex/cf-scratch-pr2
```

The interrupt landed during the first Bash call, which Claude then reports as a rejected
tool use; the sleeps never ran. Then the daemon was stopped
(SIGTERM) and `~/cf-scratch-pr2` and `/tmp/cf-pr2` deleted. No ERROR lines in the
daemon log.

## Daemon restart

Needed: migration 0023, new RPCs and commands, and the budget stop are daemon changes.
