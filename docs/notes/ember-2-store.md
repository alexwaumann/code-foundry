# Ember, PR 2 of 3: the store, settings, seed and epochs, task board, CLI (2026-10-20)

Ember is one resident agent per daemon. The user tells it what they want; it plans,
creates worker threads with the orchestrate protocol, follows them through wakes and
reports in its own chat. It never edits files. PR 1 (`ember-1-primitives.md`) added
timer wakes, resident threads and reseeds. This PR builds Ember on them: the settings
page, the store (`internal/store/ember`), `EmberService`, the `ember.*` commands, the
code-foundry-ember skill and the mock daemon's EmberService. PR 3 is the GUI.

## Layout

`<home>/residents/ember/` (`paths.Residents()/ember`), the resident thread's cwd:

```
SOUL.md            who Ember is; written from files/soul.md on first enable, then the user's;
                   re-read at every epoch (system prompt append)
MEMORY.md          long-lived facts; rewritten by consolidation; "## Notes" gets `ember remember` lines
state.json         epoch, epoch_started_at, last_consolidated_at, last_consolidation_error, worker_next
seed/              BOARD.md, PROJECTS.md, RECENT.md: rebuilt before every epoch (an --add-dir)
skills/            .claude/skills/code-foundry-ember/SKILL.md + VERSION (skills.Install; an --add-dir)
consolidation/     <UTC stamp>-input.md and -output.md of the last 5 consolidations
```

The skill sits at `skills/.claude/skills/...` rather than the brief's
`skills/code-foundry-ember/`: Claude Code loads skills from an add-dir's
`.claude/skills`, and `skills.Install` writes that layout (as for every thread's skills).
Ember also gets every thread's skills (orchestrate, help, plugin) through the usual first
add-dir. The ember skill lives in `internal/skills/files/code-foundry-ember/`, and
`skills.Render` leaves it out: only `skills.EmberFiles` (Ember's directory) has it.

## Settings (page "Ember", group `ember`)

| key | type | default | section |
|---|---|---|---|
| `ember.enabled` | Bool | false | Experiment ("Experimental:" starts the description: the schema has no tag field) |
| `ember.model` | Enum (registry) | `claude-opus-4-8[1m]` (`model.EmberDefault`) | Models (row with effort) |
| `ember.effort` | Enum low/medium/high | high | Models |
| `ember.worker_models` | String, ids comma-separated, checked against the registry (≥1, no repeats) | `claude-opus-4-7[1m],claude-opus-4-8[1m]` (`model.EmberWorkersDefault`) | Models; PR 3 adds a chips widget |
| `ember.worker_effort` | Enum (all efforts) | high | Models |
| `ember.epoch_context_tokens` | Int 20000..1000000, unit "tokens" | 400000 | Epochs |
| `ember.epoch_max_hours` | Int 1..720, unit "h" | 24 | Epochs |

All of them apply live. The store does not import the settings store: `settings`
imports `command`, which imports `ember`, a cycle. The daemon maps the settings onto
`ember.Config` (`internal/daemon/ember.go`, `emberConfig`) and calls
`Store.ConfigChanged` from `settings.OnChange`. A model or effort change reaches the
resident at once (`SetModel`, `SetEffort`). The page sits after Source control.
`CODE_FOUNDRY_DEV_RESIDENTS` and `residents_dev.go` are gone.

## Enable and disable

- **On** (at start, or when `ember.enabled` turns true): the store prepares the home,
  then builds the seed and calls `EnsureResident("ember", {Cwd: home, DisplayName
  "Ember", Model, Effort, PermissionAuto, SystemPromptAppend, AddDirs: [skills, seed],
  Prefix})`. For an existing resident it brings model, effort and permission mode in line
  (auto: the mode the app uses for unattended agents; never bypass). A resident that has
  no seed (made by hand) is reseeded once.
- **Permission rules**: `thread.Manager.SetResidentTools(name, ResidentTools{Allow,
  Deny})`, set by the store at every start and applied on every spawn of that resident
  after `ProtocolAllowedTools`. In memory, not persisted, so the brief's
  ResidentOptions/ReseedOptions field (and a migration) is not needed. Allow:
  `Bash(code-foundry ember:*)`, `thread:*`, `project:*`, `guide:*`, `help:*`, `git
  log/diff/show/status:*`. Deny (`--disallowedTools`): `Edit`, `Write`, `NotebookEdit`.
  The deny list backs "never edits files" with more than a rule in its prompt.
- **Off**: the timers go (`Unsubscribe TargetTimer`) and a running process is stopped
  (`Close`), both in the background. The thread, memory and board stay. Back on, the same
  thread comes back with its session.

## The seed

**System prompt append** (`SystemPrompt`): the embedded `files/rules.md` (2.8 KB, test
cap 6 KB), then SOUL.md, together at most 48 KB. Rules: who it is; its text is the
reply, kept short, one line or nothing for an empty wake; never edit files, only the CLI,
read-only git and reads; a task before every piece of work and one worker per piece;
`--notify --brief --labels`, never `--model`; tasks as `[Title](cf-task://<id>)` on their
own line, once, never a table; a failed or blocked worker means a blocked task, said
once, no retry without asking; ask only when blocked; `ember board` is the truth.

**Prefix** (`Prefix`), at most 250 KB (the thread store's cap is 256 KiB). Example, from
the live run (trimmed):

```
[code-foundry ember seed] You are starting a new epoch; your earlier context is gone but the user's chat continues. Read on, then answer the message at the end.

=== MEMORY.md ===
# Memory
…
## Preferences
- Scratch work: push branches without opening PRs (user's standing preference).
…
## Notes
- 2026-10-20: The user prefers branches pushed without PRs for scratch work

=== BOARD.md ===
# Task board

As of 2026-10-20 05:45. `code-foundry ember board` prints it live; `ember task show <id>` one task.

## Done today

- t-58aba4d5 Add 'Built with Ember.' line to hello README · worker s-83a65d02bfde needs attention (finished), report done: …, 1m — Pushed branch cf/add-built-with-ember-to-readme (commit 20ee8f4) …

Earlier: 0 done, 1 cancelled (`code-foundry ember task list --all`).

=== PROJECTS.md ===
# Projects

Every project the user has, with its latest threads. `--project` takes the id.

- **hello** (`2668ca879ce9`) · /Users/alex/scratch-ember-pr2/hello · git, default branch main

=== RECENT.md ===
# Recent messages

Your chat with the user, the last 3 messages, oldest first (wakes and tool calls left out).

### 2026-10-20 05:44 · user
In the hello project, add the line 'Built with Ember.' at the end of README.md. …

### 2026-10-20 05:44 · Ember
[Add 'Built with Ember.' line to hello README](cf-task://t-58aba4d5)
…

=== end of the seed; the message follows ===
```

- MEMORY.md is capped at 32 KB in the prefix. BOARD.md has sections In progress, Up
  next, Blocked and Done today (done since local midnight), with a subtask under its
  parent when both sit in one section, and one "Earlier: N done, M cancelled" line;
  capped at 32 KB. PROJECTS.md lists every project with its id, path and git/default
  branch, plus its last 3 threads the user sees (not archived, not resident or
  plugin-owned, `InSidebar` with threads.show_created_threads) and their states; capped
  at 16 KB.
- RECENT.md holds the last 40 visible messages: the user's own (wakes left out) and
  Ember's top-level replies, with one turn's texts joined into one message, each at most
  2 KB. The oldest go first until it fits the budget left in the prefix (at most
  200 KB). A wake starts a new reply message.
- Pure functions, table-tested on fixtures: `RenderBoard`, `RenderProjects`,
  `RenderRecent`, `Prefix`, `RecentBudget`, `SystemPrompt`, `visibleMessages`,
  `ConsolidationInput`, `ValidMemory`, `AddNote`.

## Epochs

`epochDue` (table-tested) makes a new epoch due only when the resident is quiet after a
turn of the current epoch:

- not busy or starting, no pending request, no wake pending, no reseed or seed waiting;
- and `LastResultAt` is after the epoch's start;
- and then either `ContextTokens > ember.epoch_context_tokens` ("context") or the epoch
  is older than `ember.epoch_max_hours` ("age").

The store checks this on every thread event (the bus is only a trigger; it re-reads the
snapshot) and once a minute. A due epoch runs `boundary` on its own goroutine
(`consolidating` meanwhile, which EmberService shows):

1. consolidation (a failure keeps MEMORY.md and goes on);
2. a rebuilt seed;
3. `Reseed`;
4. state.json updated (epoch, start, consolidation time and error).

`code-foundry ember reseed` runs the same boundary on demand and returns once it is
recorded; with nothing to consolidate there is no claude call.

The epoch's start is persisted in state.json. When the thread's epoch differs from the
recorded one (a reseed, or a first sight), the start becomes now (the thread's creation
for epoch 1).

## Consolidation

A one-shot `claude -p --model <ember.model> --effort low --no-session-persistence
--safe-mode --tools ""`, with the prompt on **stdin** (the input can reach 300 KB, too
much for one argument), run in Ember's home. Like ClaudeNamer, it falls back for good to
the minimal flags when Claude refuses one (`thread.IsFlagRefused`, now exported). It
never runs inside Ember's context.

The input is `files/consolidate.md` (keep preferences, conventions, people, standing
decisions and open follow-ups with task ids; drop chatter, board progress and finished
details; keep the "## Notes" lines unless superseded; start with "# Memory"; under
32 KB; output only the file). Then come the current MEMORY.md, the tasks changed since
the last consolidation (`- t-… [state] title — outcome`) and the visible conversation
since then. It is capped at 300 KB, dropping the oldest messages first.

`ValidMemory` checks the output: trimmed, a code fence removed, it must start with "# "
and be at most 32 KB. Anything else keeps the old file, and the error is in the status.
Notes remembered while the call ran are merged back (`keepNewNotes`). The default timeout
is 5 minutes. Measured live with Haiku: 2.8 to 3 s.

## The task board

Table `ember_tasks` (migration 0042):

- `id`: `t-` and 8 hex digits;
- `title`: one line, ≤200 bytes;
- `detail`: ≤4000 bytes;
- `state`: todo, doing, blocked, done or cancelled, stored as text;
- `parent_id`: one level only, so a subtask's parent must be top-level;
- `thread_id`: must exist when set;
- `outcome`: ≤2000 bytes;
- `position`: appended at the end;
- `created_at`, `updated_at`, `done_at`: done stamps `done_at`, leaving done clears it.

Each task's progress is derived when the snapshot is built: its worker's name, state,
status and reason, its report (status, summary, time), when it was created and last
active, and whether it is archived or removed. The store republishes when any of that
changes (deep-equal against the last snapshot).

Rules:

- A doing task whose worker reports failed or blocked after the task last changed
  becomes blocked, with the report's summary as its outcome. Ember setting it back to
  doing is newer than that report, so it is not blocked again.
- A done report never completes a task: Ember checks the work and runs `ember task done`.
- Archiving or removing the worker keeps the task (`Removed` shows).
- Every change publishes `ember.Changed{Snapshot}`.

## Worker models

`thread.Manager.SetCreateDefaults(func(ctx, createdBy, needModel, needEffort) (model,
effort))`: the thread store calls it in Create, with a creator and an open model or
effort, before anything is made. The Ember store answers for the resident and for any
thread below it (it walks `CreatedBy`):

- the model is the next of `ember.worker_models`, round robin, with the counter in
  state.json and so across restarts;
- the effort is `ember.worker_effort`;
- an explicit model or effort wins.

Detail the brief did not see: the CLI's `thread new` gets `--model` and `--effort`
**filled in by the registry from threads.default_model and threads.default_effort**
(command ArgDefaults), so the daemon never saw an empty model. So:

- `command.Args.Given(name)` tells a value passed by the caller from a context's or a
  Default's;
- thread.new sets the new `CreateThreadRequest.model_defaulted` (22) and
  `effort_defaulted` (23) when a default filled them;
- `CreateOptions.ModelDefaulted` and `EffortDefaulted` let the hook replace those values,
  as it does an empty one.

## Surface for PR 3

Proto `proto/codefoundry/v1/ember.proto`, `EmberService`:

- `GetStatus` → `EmberStatus`: enabled, thread_id, epoch, epoch_started_at,
  context_tokens, epoch_context_tokens, consolidating, last_consolidated_at,
  last_consolidation_error, counts {todo, doing, blocked, done, cancelled}.
- `ListTasks{open}` → `EmberTask`s in board order: id, title, detail, state
  (`EmberTaskState`), parent_id, thread_id, outcome, position, created_at, updated_at,
  done_at, thread (`EmberTaskThread`: id, name, state, status, status_reason,
  report_status, report_summary, report_at, created_at, last_activity_at, archived,
  removed).
- `WatchBoard` → stream of `EmberBoard{status, tasks}`: the whole board, then again on
  every change. Events are coalesced.

The board is read-only: no UpdateTask RPC. The chat is the resident thread (`kind`
RESIDENT, `resident_name` "ember"). Task links in Ember's replies are
`[Title](cf-task://t-…)`, one per line.

Mock (`gui/frontend/mock/ember.ts`), with `ember.enabled` wired to the mock settings:

- `GET /__mock/ember`;
- `POST /__mock/ember?enabled=`;
- `/task?id=&state=[&outcome=]`;
- `/task/add?title=[&state][&parent][&thread][&detail]`;
- `/consolidating?on=`;
- `/epoch`.

The seeded tasks cover every state: t-1a2b3c4d doing (with worker s-ember-notes),
t-5e6f7a8b its todo subtask, t-9c0d1e2f blocked, t-3a4b5c6d done today, t-7e8f9a0b
cancelled. Ember is off after a reset.

CLI, category "Ember" (a guide topic `ember`; NoKeybinding; hidden from the palette by a
prefix rule in `keys/bindings.ts`). Task ids take a unique suffix (`EmberTaskID`):

```
ember status [--json]
ember board
ember task add "<title>" [--detail @file|-|text] [--parent <id>] [--thread <id>] [--state doing]
ember task update <id> [--title] [--detail] [--state] [--thread] [--outcome]
ember task done <id> ["<outcome>"]
ember task cancel <id> ["<why>"]
ember task list [--all] [--json]
ember task show <id> [--json]
ember remember "<fact>"
ember reseed
ember enable | ember disable          (set ember.enabled; enable waits up to 10 s for the thread)
```

The JSON is plain Go views with camelCase fields (`EmberStatusView`, `EmberTaskView`):
`command` cannot import `api`, which imports it. Without an Ember store the commands
still list and fail with Unimplemented.

## End to end (2026-10-20, scratch home)

Setup:

- `make build`;
- `CODE_FOUNDRY_HOME=/tmp/ember-pr2-home CODE_FOUNDRY_BIN=<worktree>/bin/code-foundry
  bin/code-foundry daemon --dev`;
- `cf` is a wrapper that pins that home;
- Ember and its workers on Haiku 5.5 at medium (`settings set ember.model`, `ember.effort`,
  `ember.worker_models`, `ember.worker_effort`);
- a scratch repo `~/scratch-ember-pr2/hello` with a local bare `origin`, registered with
  `project add`.

1. `ember enable` → `Ember is on: thread s-d0d940a83db4`. The home holds SOUL.md,
   MEMORY.md, seed/ (PROJECTS.md lists hello), skills/.claude/skills/code-foundry-ember
   and state.json.
2. `thread send --id <ember> "In the hello project, add the line 'Built with Ember.' at
   the end of README.md. Commit and push the branch; open no PR." --wait`. In 15 s Ember:
   - loaded the ember and orchestrate skills;
   - ran `ember task add` (t-58aba4d5);
   - ran `thread new --project … --new-worktree --labels ember,t-58aba4d5 --notify
     --request-id t-58aba4d5` with no `--model`;
   - ran `ember task update --thread --state doing`;
   - replied with the task link and two lines.

   The worker was a hidden child (`↳ Ember`) on `claude-haiku-5-5[1m]` medium, from the
   hook (log: `creator's defaults for a new thread`), not the threads.default_model it
   was given.
3. The worker committed and pushed, and reported done. The wake landed. Ember checked
   `git log origin/cf/…` in the worktree, ran `ember task done t-58aba4d5 "Pushed branch …
   (commit 20ee8f4) …"` and replied in three lines. `ember task list` showed the task
   with the worker's derived status and report.
4. Auto-block, live: a doing task on the same worker, then `thread report --id <worker>
   failed "synthetic…"`. The task became blocked with that summary as its outcome.
5. `ember remember …`, then `ember reseed` (3.3 s):
   - consolidation (Haiku, 2.8 s) rewrote MEMORY.md into Preferences, Projects and Open
     follow-ups, keeping the Notes line;
   - the thread went to epoch 2 with `seedPending`;
   - the next message spawned a new `--session-id` (no `--resume`) and logged `sent the
     seed prefix … prefix_bytes=2578`;
   - `thread items --json` shows the message's `seedPrefix`;
   - Ember answered "what did you do for me / what do I like" from the seed alone.

   The argv carried both add-dirs, the rule list ending `Bash(git status:*)`, and
   `--disallowedTools Edit Write NotebookEdit`.
6. `settings set ember.epoch_context_tokens 20000`: the last turn was at 25.6K, so an
   epoch was due at once (`reason=context`). It consolidated, then reseeded; a message
   sent meanwhile went to the old session (reseed_pending), and Claude stopped after
   that turn. The next message ran in epoch 3. That turn's context was again over 20K,
   so epoch 4 followed automatically. Reset to the default afterwards.
7. `ember disable` (the thread stays, status off). Daemon stopped (SIGTERM) and started
   again: `ember status` showed epoch 4 and the board intact. `ember enable` brought the
   same thread back.

Then the daemon was stopped and the scratch home, repos and transcript directories
deleted.

## Gotchas

- **20000, the minimum epoch limit, is below a fresh session's own context** (system
  prompt, skills and tools come to ~24K with Haiku). At the minimum every turn ends an
  epoch, with a consolidation each time. It is bounded (once per turn: `LastResultAt`
  must be after the epoch's start) but wasteful. The brief chose 20000 to show a
  boundary; a floor of ~50000 may suit real use.
- **Messages sent while a reseed waits** go to the old session (PR 1's semantics) and
  are not in the new epoch's RECENT.md: the seed is built before the reseed. They are
  in the next consolidation, which starts at the last consolidation's time.
- **Haiku chained the task update into the `thread new` command** with a `$(…)` that
  produced an empty `--thread` (taken as absent), noticed, and redid it. The skill now
  says "two separate commands, take the id `thread new` printed".
- Ember ran `cd <worker's worktree> && git fetch && git log origin/<branch>` to check
  the work: auto mode allowed `git fetch`, which is not strictly read-only but changes
  only remote refs.
- A worker's `failed` report after its task was done does not touch the done task (only
  doing tasks are blocked). Ember, seeing the newer failed report in the seed, flagged
  the conflict to the user.
- The `ember_tasks` state is TEXT, so a state an older build does not know loads as
  todo rather than failing the store.
- `go run ./cmd/code-foundry guide` without `CODE_FOUNDRY_HOME` reaches the user's live
  daemon (read-only; a CLI only starts a daemon when none answers). Always set the home.

## Daemon restart

Needed after merging: migration 0042, the new service and commands, the settings.
