# Waiting on the thread's own background work (2026-10-31)

A user asked that "Waiting" mean "something will wake this thread without me". Since
docs/notes/orch-waiting-status.md a plainly ended turn holding subscriptions on working
child threads shows idle "waiting on N child threads" instead of ringing "finished".
A turn that ended while its own background subagent or background shell still ran
still rang "finished", though Claude reports that work back by itself a moment after it
ends. This extends the same overlay to that work. Daemon only (`internal/store/thread`,
the CLI's status word, the proto comment); the GUI's parser is a separate PR.

## Decisions

* **Same overlay, more inputs.** `waitingLocked` (waiting.go) now counts, besides the
  pending subscription targets: the thread's background subagent runs still running
  (`AgentsRunning`'s background count: depth-1 Agent calls with run_in_background, the
  `background_agents_running` field), its background shells (`BackgroundShellsRunning`:
  Bash with run_in_background, Monitor), and `WakePending` (a background end arrived at
  the prompt and the turn Claude starts by itself to report it has not ended yet). Same
  raw statuses as before (needs attention `finished`, idle `at prompt`), same winners (a
  question, a permission prompt, a turn error, the budget stop, the wake limit, a
  timer's turn). No new proto field; the counted fields keep their meaning (the
  hidden-connection auto-stop and the update/archive dialogs read them directly).
* **Only while the process runs** (`ownWork`: `State == StateConnected`). The work dies
  with the process; a disconnected row with a stale count must not wait forever.
* **The reason grammar.** `"waiting"` alone while only a wake is queued (a subscription
  wake) or due (`WakePending`, Claude's own report). Otherwise `"waiting on "` + the
  non-zero parts joined by `" and "`, in this order: `N child thread(s)`,
  `N subagent(s)`, `N shell(s)`. Examples: `waiting on 2 child threads`,
  `waiting on 1 subagent`, `waiting on 2 child threads and 1 subagent`,
  `waiting on 1 subagent and 2 shells`. Children only is byte-identical to before.
  `Waiting.Reason` builds it, `ParseWaiting` reads it back; documented on
  `Thread.status_reason` in thread_lifecycle.proto.
* **`WaitingOn` still returns the child-thread count** (0 for "waiting on 1 shell").
  Its one caller, Ember's board (`team.go` `working`), counts a worker as working while
  it waits on child threads; a worker waiting only on its own background work reads
  idle there exactly as it did when it showed "finished". Whether Ember should call
  that working is a separate question, not changed here.
* **A parent waits through it.** `pendingLocked` treats a target waiting on its own
  background work as pending, like a lead waiting on its workers, so a parent
  subscribed to it keeps waiting.
* **The CLI**: `thread list` prints `waiting (on 1 shell)`, `waiting (on 1 subagent)`,
  `waiting (on 2 children and 1 subagent)` (child threads read "child"/"children" as
  before; the other parts verbatim); elsewhere `idle (waiting on 1 shell)`.
* **The guide** (`internal/guide`, built from the command registry) never described the
  waiting status words, so nothing there changed and its byte cap was not touched.

## The wake path (verified, not assumed)

The end of a background shell (`bgshells_runner.go` `onShellTask`) or agent run
(`agents_runner.go` `onTask`) at the prompt calls `expectWake` *before* it publishes the
lower count, so `WakePending` is already on the row when the count drops: the overlay
goes `waiting on 1 shell` -> `waiting` (never "finished" between). Claude's own turn sets
busy (`status: requesting`, debounced 100 ms); while that busy is in the debounce the raw
status is still the old `finished` and `WakePending` keeps it waiting. The report turn's
result clears `WakePending` (`wakeOver`) and its end shows `finished`, the one bell, for
the report.

* **No report** (`WakeTimeout` lapses with no turn): `WakePending` clears and the thread
  shows the ended turn, needs attention `finished`, as it always did (a bell, now later:
  when the work truly ended). Pinned by `TestWaitingOnBackgroundWorkNoReport`.
* **An end during a turn** calls no wake (the turn reports it); the thread is busy then.

## Gotchas

* **A long-lived background shell keeps the thread waiting.** A dev server or watcher
  started with run_in_background never ends, so the thread reads "waiting on 1 shell"
  until it is stopped or the process ends, and its turn's end does not ring. That is
  the agreed rule (it will report, if it ever ends); if users find it wrong for servers,
  excluding shells with listening ports (`BackgroundShell.Ports`) is the obvious
  follow-up.
* The fake Claude replays the report turn faster than the status debounce, so the unit
  test sees `waiting` -> `finished` with the busy folded away (it allows the busy); the
  live check saw the busy.
* Attention counts (bell, dock badge, window title) are the GUI's and count status
  needs-attention only; the overlay is status idle, so no new bells. No daemon-side
  counter reads the status for alerts.

## Verified

* `make check` green. New tests: `TestWaitingReasonParts` (grammar and round trip),
  `TestWaitingOnBackgroundWork` (children only, a subagent, two shells, child +
  subagent, subagent + shells at prompt, all three, the report due alone, shell + report
  due, foreground and nested runs not counted, a question wins, busy is busy, no
  process no work; the counts falling to finished; a parent waiting on a child that
  waits on its shell), `TestWaitingOnBackgroundWorkUntilTheReport` (shells and agents
  fixtures through a real runner: waiting on 1 shell / 1 subagent, waiting while the
  report is due, finished at the report's end, never finished before),
  `TestWaitingOnBackgroundWorkNoReport`, and the CLI's `TestThreadStatusWordWaiting`.
* Live, isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-waiting-bg`, this branch's build), a
  scratch repository under home, a Sonnet 5.5 medium thread told to run
  `sleep 45; echo done` with run_in_background and end its turn. `thread list` every
  0.5 s: 20:09:46 `busy`; 20:09:47 `waiting (on 1 shell)` (the API: IDLE `waiting on 1
  shell`, background_shells_running 1) for 44 s, never `attention`; 20:10:31 the daemon
  logged "background shell ended" and "expecting Claude to wake", and the row read
  `waiting`; 20:10:32 `busy` (Claude's own report turn); 20:10:33 `attention
  (finished)` ("background wake over: Claude's turn ended"). The timeline: the launch,
  "Started the 45-second background sleep.", turn end, "The 45-second sleep finished
  and printed "done".", turn end. The subagent path was checked with the agents fixture
  through a real runner, not live.
