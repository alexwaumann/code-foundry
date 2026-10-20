# Ember, PR 1 of 3: the daemon's primitives (2026-10-20)

Ember is one resident agent per daemon: the user tells it what they want, it plans,
starts worker threads with the orchestrate protocol, follows them and reports in its own
chat. It runs as one ordinary headless thread whose Claude session is replaced now and
then by a fresh one ("a new epoch") that the daemon seeds with memory, a task board and
recent messages, while the conversation stays in `thread_items`. This PR adds the three
generic primitives that needs, in the daemon, the API and the CLI; PR 2 builds the Ember
store on them, PR 3 the GUI (the pinned row above New thread and its chat). Nothing here
is named "ember" except the development aid and examples.

## What was built

### 1. Timer wake subscriptions

A fifth target kind, `timer` (`TargetTimer`, proto `THREAD_SUBSCRIPTION_TARGET_TIMER`),
condition `fired` (`CondFired`, shared with plugin targets).

* `code-foundry thread subscribe --at <RFC 3339 | duration>` fires once (a duration is
  from now: `--at 30m`); `--every <duration>` (at least 1m) repeats until unsubscribed
  (repeat implied). Exclusive with the other targets and with each other; `--until` only
  as `settled` (meaning fired). `thread unsubscribe --timers` removes every timer of the
  thread; by id works as for any subscription.
* Proto: `SubscribeThreadRequest.target_at` (Timestamp) and `target_every` (Duration);
  `UnsubscribeThreadRequest.target_timer`. Store: `SubscribeOptions.TargetAt` /
  `TargetEvery`, `UnsubscribeOptions.TargetTimer`.
* The target id is the schedule itself: `at:2026-10-20T19:00:00.000Z` (UTC, ms) or
  `every:30m`. So the same timer twice from the same thread is the same subscription
  (`existed`), like any other target.
* The wake is an ordinary WAKE message through the subscriber's queue (so it starts a
  stopped subscriber, unsnoozes one, and counts toward the 60/hour wake limit):

  ````
  [code-foundry wake] Timer sub-dd077e1efddb fired at 04:52 CDT (every 1m).
  ```json
  { "kind": "timer", "subscription_id": "sub-…", "condition": "fired",
    "fired_at": "…", "due_at": "…", "every": "1m" }      // or "at": "…" for a one-shot
  ```
  ````

  A one-shot's header ends `(set for 09:00 CDT)`. Times in the header are local
  (`15:04 MST`, with `Jan 2` when not today), like the restart notice; the JSON is UTC.
* Schedule: wall clock, like snoozes (Go's monotonic clock stops while the Mac sleeps).
  `fireTimers` runs every `Options.TimerCheckInterval` (default 10 s), so a timer is at
  most ~10 s late. An interval's slots are counted from its creation (`CreatedAt +
  k·every`); the next slot is the first after `LastFiredAt`, so a late fire does not
  drift the schedule and nothing extra needs persisting.
* Restarts: timers persist in `thread_subscriptions` (no migration: the existing columns
  hold them) and are kept at startup when their subscriber lives. The first check runs
  one interval after `New`, when the daemon is up: a one-shot whose time passed while the
  daemon was stopped fires then and goes; an interval that missed slots fires once (one
  catch-up wake, `due_at` the oldest missed slot) and resumes its schedule.
* A fire the wake limit drops is not counted and is tried again a minute later
  (`subRec.retryAt`, in memory), so a flooded subscriber is not hit every check.
* Removed with the subscriber (archive, remove) like every subscription
  (`forgetLocked`). Listed by `thread subscriptions` as `timer every 30m` /
  `timer at 14:00 CDT`, status `next 14:30 CDT` or `due`.
* Docs: `ARCHITECTURE.md` §4, the guide's Conventions (one bullet), the orchestrate
  skill's `reference/wakes.md` (§ Timers).

### 2. Resident threads

* `Thread.kind` (`ThreadKind`: UNSPECIFIED = ordinary, RESIDENT) and
  `Thread.resident_name`; store `Thread.Kind` (`KindNormal`, `KindResident`) and
  `ResidentName`; persisted (migration 0041, a unique partial index on `resident_name`).
* Made only by `Manager.EnsureResident(ctx, name, ResidentOptions{Cwd,
  SystemPromptAppend, AddDirs, Model, Effort, PermissionMode, DisplayName, Prefix})`
  (also on the `thread.Store` interface and the threadtest fake). It returns the
  resident of that name, or makes it: stopped (DISCONNECTED, idle, no process until a
  message), no project or workspace, `WorktreePath` = `Cwd` (absolute; made with 0700;
  not required to be under the home directory, unlike a no-project thread's cwd),
  `Name` = DisplayName or the name, epoch 1, `FreshStart` set and the seed applied (so
  its first session already gets the system prompt append, add-dirs and prefix). An
  existing resident is returned as it is: change it with SetModel, SetEffort,
  SetPermissionMode, Rename and Reseed. Names: `^[a-z][a-z0-9-]{0,31}$`.
* Refused (FAILED_PRECONDITION "thread s-… is the resident ember thread; it cannot be
  archived|snoozed|removed|forked"): Archive(true), Snooze (a time), Remove, Fork; the
  CLI verbs print the daemon's refusal (exit 2). There is no re-parenting API (created_by
  is set once), and SetSidebar already refuses a thread without a creator. Unarchive,
  unsnooze and Pin are harmless no-ops or allowed.
* Never auto-named: `namedForGood` is true and `nameProvisionally` does nothing for a
  resident (the namer is never called, also after a fresh start).
* Lists: a filtered `ThreadService.List` leaves residents out unless
  `ThreadFilter.include_resident` or `all` (`thread list --resident`, marked
  `[resident ember]`). An unfiltered List (the GUI's) and Watch carry every thread, so
  PR 3 sees it; Get works (`thread get` prints a `session:` line).
* GUI: `ThreadView.resident` (the name) and `epoch` (only on a resident); `isOwned` now
  counts a resident, so `order` leaves it out, and with it the sidebar, attention counts,
  running counts, dock alerts, lineage and pickers (`owned` keeps it; the usage page
  still counts its cost). Nothing renders it yet (PR 3).
* Everything else is an ordinary thread: a message starts it, it stops at its cache
  expiry, wakes and timers reach it, threads it creates (`thread new` from inside it)
  have `created_by` = the resident and are hidden children as usual. Nothing archives
  it, so the hidden-children cascade never starts from it.
* Development aid: `CODE_FOUNDRY_DEV_RESIDENTS=ember[,scout]` makes those residents at
  daemon startup in `<home>/residents/<name>` (`paths.Residents()`,
  `internal/daemon/residents_dev.go`). PR 2's settings flag replaces it.
* Mock daemon: `MockThread.resident` and `epoch` pass `kind`, `resident_name` and `epoch`
  through; `POST /__mock/resident` adds `s-resident-ember` ("Ember", stopped, epoch 2).

### 3. Reseed

* `Manager.Reseed(ctx, id, ReseedOptions{SystemPromptAppend, AddDirs, Prefix}) (Thread,
  stopped bool, error)`; rpc `ThreadService.Reseed(ReseedThreadRequest{id,
  system_prompt_append, add_dirs, prefix}) → ReseedThreadResponse{thread, stopped}`; CLI
  `code-foundry thread reseed --id <id> [--system-prompt @file|-|text] [--add-dir D]...
  [--prefix @file|-|text]`.
* The seed replaces the thread's: what is not given is cleared (PR 2 passes it whole
  every time). Bounds: append 64 KiB (it goes on claude's command line), prefix 256 KiB
  (stdin), no NUL, add-dirs absolute (cleaned, deduplicated; a missing one is skipped at
  spawn, as before).
* Persisted per thread (migration 0041): `system_prompt_append` (every spawn appends it
  to `--append-system-prompt`, after the app's line and a workspace's, separated by a
  blank line), the existing `spawn_add_dirs` (now rewritable; every spawn passes them),
  `fresh_start` (the next spawn starts a new conversation; cleared by that spawn),
  `seed_prefix` (cleared once the message carrying it went out), `epoch` (1 for every
  thread, plus one per Reseed).
* Proto: `Thread.epoch`, `reseed_pending`, `seed_pending` (a prefix waits), and
  `UserMessageItem.seed_prefix`. The append and the prefix themselves are not on the
  Thread message (every update goes to every client; 64 KiB would ride along).
* Semantics:
  * Stopped (or closing): only recorded; `Reseed` resets the context size at once.
  * Running and quiet (at its prompt, no pending request, no background agents or
    shells, nothing on its way, not starting): stops at once (`stopped` true,
    disconnect reason `reseed`).
  * Running and working: `reseed_pending` until the turn and its background work end,
    then it stops. Implemented as the idle stop's holds (`idleHoldOf`) without the
    effort change, the grace and the cache (`reseedHoldOf`), checked wherever an effort
    restart is (`maybeRestart` calls `maybeReseed` first: every command, stream event
    and tick). A message sent before then goes to the old session.
  * The next spawn (a message, an MCP refresh) is fresh: `resumeLaunch` returns a new
    `--session-id` without `LastError` or the "transcript is gone" note;
    `ClaudeSessionID` is replaced; the old transcript stays in `Transcripts`, so usage
    keeps counting it.
  * The prefix: the runner of a fresh session holds `seed` and puts it before the first
    message it sends, whichever path that message takes (the first prompt, a queued one,
    a live send): Claude gets `<prefix>\n\n<message>` (and a resume note, if one is
    pending, sits between them); the item keeps the text and gets `SeedPrefix`; the row's
    `seed_prefix` is cleared then, unless a newer reseed replaced it.
  * `epoch` goes up by one per call (two calls before a start make two epochs);
    `context_tokens` goes to 0 (at the call for a stopped thread, when the process ends
    for a running one), so PR 2 never reads the old session's size after a reseed.
  * Grants and MCP: a reseed is a stop. What "allow for session/thread" granted the old
    process goes with it (as at every idle stop, which happens far more often than a
    reseed); an effort restart keeps them only because it resumes the same conversation.
    The cached MCP status and slash commands stay until the new process reports, as
    after any stop.
  * An effort change or a user's restart while a reseed waits still restarts the old
    session (they hold sends; refusing them would strand those sends); the reseed stops
    the restarted process once it is quiet.
* Any thread may be reseeded; the palette hides `thread.reseed` (`keys/bindings.ts`
  `paletteHidden`), and it has no keybinding.

### 4. Context size

Already there: `Thread.context_tokens` (since `rendered-threads-cold-cache.md`) is the
last top-level API response's input + cache read + cache write + output tokens, persisted
with the row and published after every result. The brief asked for a new
`last_context_tokens` without the output tokens; I used the existing field rather than
add a near-duplicate (the difference is one reply's output, which is in the next turn's
context anyway). New: a reseed resets it, and `thread get` prints it (`session: … context
45.2K tokens`). PR 2 reads `Thread.ContextTokens`.

## The surface for PR 2

Store (`internal/store/thread`), all on `thread.Store`:

```go
EnsureResident(ctx, name string, o ResidentOptions) (t Thread, created bool, err error)
type ResidentOptions struct {
    Cwd string                 // absolute; made
    SystemPromptAppend string  // the first epoch's seed
    AddDirs []string
    Model, Effort string
    PermissionMode PermissionMode
    DisplayName string         // default: the name
    Prefix string              // the first message of the first session starts with it
}
Reseed(ctx, id string, o ReseedOptions) (t Thread, stopped bool, err error)
type ReseedOptions struct { SystemPromptAppend string; AddDirs []string; Prefix string }
Subscribe(ctx, SubscribeOptions{SubscriberID: id, TargetEvery: 30 * time.Minute})  // or TargetAt
Unsubscribe(ctx, UnsubscribeOptions{SubscriberID: id, TargetTimer: true})
```

Thread fields: `Kind` (`KindResident`), `ResidentName`, `Epoch`, `ContextTokens`,
`ReseedPending`, `SeedPrefix` (non-empty: the prefix has not gone out yet),
`SystemPromptAppend`, `SpawnAddDirs`, `FreshStart`. Item: `SeedPrefix`.
`ListOptions.IncludeResident`. `paths.Paths.Residents()`. Errors:
`ErrFailedPrecondition` for the refused actions, `ErrInvalidArgument` for a bad seed,
name or cwd.

Proto: `Thread.kind` (63, `ThreadKind`), `resident_name` (64), `epoch` (65),
`reseed_pending` (66), `seed_pending` (67); `ThreadFilter.include_resident` (14);
`rpc Reseed`; `UserMessageItem.seed_prefix` (9);
`ThreadSubscriptionTarget.THREAD_SUBSCRIPTION_TARGET_TIMER` (5),
`SubscribeThreadRequest.target_at` (12) / `target_every` (13),
`UnsubscribeThreadRequest.target_timer` (11).

CLI: `thread subscribe --at/--every`, `thread unsubscribe --timers`, `thread reseed`,
`thread list --resident`, `thread get`'s `session:` line.

## Decisions (made here; flag in review)

* **Context size**: the existing `context_tokens`, not a new field (above).
* **`--system-prompt` and `--prefix` take `@file` / `-`** (the CLI's FileOrStdin, like
  `thread send`'s text and `thread report --data`) instead of `--system-prompt-file` /
  `--prefix-file` flags: one idiom for every file-or-text argument.
* **A reseed stops; it does not restart in place.** The fresh session has nothing to say
  until a message comes, and a stop lets the next message carry the prefix. Grants go
  with the old process (above).
* **The seed replaces, and an empty field clears.** PR 2 sends the whole seed each epoch;
  a partial update API had no user.
* **EnsureResident takes a `Prefix`** (not in the brief) so the first epoch is seeded
  like the others, and marks the new resident `FreshStart` so its first start has no
  "no saved conversation" `LastError`.
* **No RPC makes a resident.** The brief says the store API only; the development aid
  (`CODE_FOUNDRY_DEV_RESIDENTS`) made the end-to-end check possible.
* **Timers fire through the queue and the wake limit like any wake**; the target id is
  the schedule (dedup for free); interval slots anchor on creation (no new column).
* **Resident in the GUI via `isOwned`**: one rule hides plugin-owned and resident
  threads from the user's lists; `owned` keeps it for PR 3.

## Gotchas

* `pgrep -f` for the daemon matched the backgrounded `sh -c "cd … && … daemon"` first:
  killing it left the daemon running, and the restart said "another daemon is already
  running". Match the daemon's own pid (its environment has `CODE_FOUNDRY_HOME`).
* zsh does not split an unquoted `$var`; loops over "verb args" strings need arrays or
  separate commands.
* `CODE_FOUNDRY_HOME` must be set for every CLI call, `guide` included: the CLI
  auto-starts a daemon on that home (`/tmp/ember-pr1-bin/cf` wrapped it).
* `FormatEvery`: trimming "0s" then "0m" from `30m0s` gives "3"; trim `m0s` and `h0m`
  suffixes instead (a test caught it in the fake first).
* A `TargetAt` equal to now passed the future check once `now` was truncated to
  milliseconds; the check compares with the untruncated clock.

## Tests

* Store: `subscriptions_timer_test.go` (FormatEvery; the target table; `timerNext` with
  late and catch-up fires; the wake message and JSON; a one-shot on a fake clock: not a
  minute early, fires, gone, starts the stopped subscriber; an interval: two wakes, the
  listing, a five-hour stop with one catch-up wake and the next slot, unsubscribe by
  `TargetTimer`; a one-shot due while stopped; refusals; cleanup with the archived
  subscriber; the wake limit with the retry), `reseed_test.go` (`cleanSeed` table;
  `reseedHoldOf` table; a stopped thread across a restart: argv without `--resume`, the
  append and the add-dir, the prefix once, the item's `SeedPrefix`, items kept; an idle
  thread stops at once with reason `reseed`; a thread at a permission prompt waits for
  its turn; refusals and clearing; `EnsureResident`: fields, cwd made, idempotent, bad
  names, the List filter, the four refusals, its first start seeded without naming, a
  child's `created_by`, persistence, a second resident), `prompt_test.go` (the append).
* DB: `thread_resident_migration_test.go` (defaults, the unique index).
* API: timer mapping both ways, Reseed (idle, busy, unknown), the resident's kind, the
  List filter, the refusals' codes.
* Commands: timer subscribe/unsubscribe/list rows and argument errors; `thread.reseed`
  messages and requests; `thread list --resident`; the `session:` line; registry and
  NoKeybinding lists. Daemon: `ensureDevResidents`. Frontend: the mapping, a resident
  kept out of `order`, attention and running counts.

## End to end (2026-10-20, isolated home)

`make build`; `CODE_FOUNDRY_HOME=/tmp/ember-pr1-home CODE_FOUNDRY_DEV_RESIDENTS=ember
bin/code-foundry daemon --dev` (no other `CODE_FOUNDRY_*`); `cf` below is the branch
binary with that home. Haiku 5.5 at medium. Output as printed (trimmed).

```
# log: resident thread created thread=s-135f6ec58673 resident=ember cwd=/tmp/ember-pr1-home/residents/ember
$ cf thread list
no threads (archived threads are left out; --archived includes them)
$ cf thread list --resident
s-135f6ec58673  idle  ember  no project  4s  [resident ember]
$ cf thread set-model --id s-135f6ec58673 'claude-haiku-5-5[1m]'; cf thread set-effort --id s-135f6ec58673 medium
$ cf thread send --id s-135f6ec58673 --text "Reply with just: ready" --wait
thread s-135f6ec58673 ember: needs attention (finished)        # still named "ember": no auto-naming
$ cf thread get s-135f6ec58673
session: resident ember, epoch 1, context 22.9K tokens
$ cf thread archive --id s-135f6ec58673 --yes      # likewise snooze, remove, fork; exit 2
code-foundry thread.archive: failed precondition: thread s-135f6ec58673 is the resident ember thread; it cannot be archived
$ cf thread subscribe --id s-135f6ec58673 --at 70s
subscribed sub-45a2c56d1e05: s-135f6ec58673 wakes at 2026-10-20T09:53:07Z (once)
$ cf thread subscribe --id s-135f6ec58673 --every 1m
subscribed sub-dd077e1efddb: s-135f6ec58673 wakes every 1m (repeat)
$ cf thread subscribe --id s-135f6ec58673 --every 30s
code-foundry thread.subscribe: "30s" is not a duration of at least 1m (30m, 2h)
$ cf thread items --id s-135f6ec58673 | grep wake:
#4 wake: Timer sub-dd077e1efddb fired at 04:52 CDT (every 1m).
#8 wake: Timer sub-45a2c56d1e05 fired at 04:53 CDT (set for 04:53 CDT).
#12 wake: Timer sub-dd077e1efddb fired at 04:53 CDT (every 1m).
# the one-shot is gone from `thread subscriptions`; each wake started a Haiku turn
# daemon stopped (SIGTERM) at 04:57:39 after the 5th interval fire (09:56:58Z),
# started again at 05:00:18: three slots missed
# log 05:00:28 wake subscription fired subscription=sub-dd077e1efddb fired_count=6
$ ... | jq .wakeJson     (the only new wake)
{ "kind": "timer", "subscription_id": "sub-dd077e1efddb", "condition": "fired",
  "fired_at": "2026-10-20T10:00:28.575Z", "due_at": "2026-10-20T09:57:58.012Z", "every": "1m" }
$ cf thread unsubscribe --id s-135f6ec58673 --timers
removed sub-dd077e1efddb: s-135f6ec58673 wakes every 1m (repeat)
$ cf thread reseed --id s-135f6ec58673 --system-prompt @sys.txt --add-dir /tmp/ember-pr1-home/residents --prefix @prefix.txt
# (the catch-up wake's turn was still running: reseed_pending, then
# log 05:00:57 stopping claude for a reseed; the next message starts a fresh session)
$ cf thread get s-135f6ec58673 --json | jq '{state, disconnectReason, epoch, seedPending, contextTokens}'
{ "state": "THREAD_STATE_DISCONNECTED", "disconnectReason": "reseed", "epoch": 2, "seedPending": true, "contextTokens": null }
$ cf thread send --id s-135f6ec58673 --text "What is the codeword?" --wait
#31 you: What is the codeword?
#33 claude: Tangerine.                                  # only the prefix said it
# spawned: … --session-id ffe5bd84-… (new; no --resume) … --add-dir /tmp/ember-pr1-home/residents
#          … --append-system-prompt <ThreadPrompt>\n\nYou are Ember, a test resident. …
# log 05:01:05 sent the seed prefix with the fresh session's first message prefix_bytes=46
$ … | jq '… .userMessage | {text, seedPrefix}'
{"text":"What is the codeword?","seedPrefix":"[seed] Your memory: the codeword is tangerine."}
$ cf thread get s-135f6ec58673
session: resident ember, epoch 2, context 23.4K tokens
$ cf thread new --no-project --name plain; cf thread list; cf thread list --resident
s-59f3af5051a7  unknown  plain  no project  now
---
s-59f3af5051a7  unknown               plain  no project  now
s-135f6ec58673  attention (finished)  ember  no project  42s  [resident ember]
```

The live run found one bug, fixed after it: when the stop began at once, the response
still carried `reseed_pending` (set until the process is gone), so the CLI said "Claude
stops when its turn ends"; it now checks `stopped` first. Then the daemon was stopped and
`/tmp/ember-pr1-home` and its transcript directory deleted.

`make check` green; `make gui-e2e`: 478 passed, 26 skipped (5.6 min), no flakes.

## Daemon restart

Needed after merging: migration 0041, new RPC and commands.
