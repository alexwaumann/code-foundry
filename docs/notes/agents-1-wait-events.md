# Agents, PR 1: `thread.wait` and resumable events (2026-10-17)

The first of five PRs that make the daemon better for agents that drive other threads
from the CLI. An agent can now block until another thread finishes (`thread wait`) and
follow the daemon's events as JSON lines (`code-foundry events`), resuming after a
disconnect without losing what happened in between (`--since <seq>`). No GUI change.

## Decisions

Agreed with Alex (the brief):

* `thread.wait` is a registry command (Thread category) that blocks in the daemon with
  the call's context, like `action.wait`: `id` (positional, defaults to the context
  thread), `until` (`idle` default, `attention`, `error`, `disconnected`), `for` (Go
  duration, default 10m, at most 24h). It returns at once when the condition already
  holds; it never waits for a transition that already happened. It follows the thread
  list on the bus, never polls.
* Result: `--json` prints the thread (the same `Thread` mapping as `thread.list`); text
  is one line, `thread s-… <name>: <status> (<reason>)`. A timeout is an error
  (DEADLINE_EXCEEDED): the CLI prints it on stderr with the thread's status then, exits
  1, and `--json` prints nothing on stdout. That is how a script tells a timeout apart.
* `Event.seq` (field 20) and `WatchEventsRequest.since_seq` (field 2), additive. One
  shared counter per daemon lifetime, starting at 1, assigned once per published event
  (not per client). Snapshots and heartbeats carry 0. The last 4096 live events are
  kept. `since_seq` inside the kept range skips the snapshots and replays the events
  after it (of the requested sources), then goes live; outside it (too old, or ahead of
  the counter as after a daemon restart) the stream starts as before: snapshots, then
  live.
* `code-foundry events [--source a,b] [--since N] [--json]` is a hand-written local
  verb (registry commands are unary). `--json` is protojson of each event, one per line;
  otherwise one compact line per event.

Decided while building (not in the brief; flagged for review):

* **`ThreadService.Wait` RPC.** The command package only talks to Connect-shaped
  backends, and `ThreadService.Watch` is a server stream a command cannot consume, so the
  wait lives in a new unary RPC (`internal/api/thread_wait.go`), as `action.wait` lives
  in `ActionService.WaitRun`. The timeout travels in the request and comes back as
  `timed_out` (not an RPC error); the command turns it into the error.
* **What `idle` means.** A finished turn is NEEDS_ATTENTION "finished" until someone
  looks at the thread (an open WatchThread acknowledges it), so "status IDLE" alone would
  never be reached by a thread nobody watches (an agent's child thread). `idle` is
  therefore "Claude is not working and no answer is pending": not STARTING, and status
  IDLE, ERROR (the process ended mid-turn), or NEEDS_ATTENTION for anything but a
  pending permission prompt or question ("finished", "error: <code>", "snooze ended").
  The prefix test is `thread.set-effort`'s `onTurn`. ERROR counts so a crashed child
  does not hold its parent for the whole timeout; the printed status says which it was.
  `attention` is any NEEDS_ATTENTION (including "finished"); `error` is status ERROR
  only (Claude's API errors stay NEEDS_ATTENTION "error: …", which `attention` and
  `idle` catch).
* **Transient topics.** UI intents and the update source's relaunch and restart
  requests are fire-and-forget: they get a seq but are never kept or replayed (a resumed
  window must not relaunch itself for an old `restart_requested`), and the hub
  subscribes them only while a stream wants their source, so the publisher's delivery
  count still says whether a window listens (`app.relaunch`/`app.restart` print "no app
  window is connected" from it). One change: with several event streams connected the
  count for those is 1 per daemon, not 1 per stream (`ui.* --json` "delivered").
* **The CLI prints no heartbeats** (they exist for WKWebView; agents only see noise).
  It stops on Ctrl-C, when the daemon ends the stream, and when stdin closes, but it
  watches stdin only when stdin is a pipe or socket: Claude's Bash tool and background
  jobs have `/dev/null`, which would end it at once.
* `thread.wait` is `NoKeybinding` and shows in the palette, like `action.wait` (no
  mechanism hides CLI-only commands). A thread's agent waiting for its own thread just times out: the registry
  overlays an explicit id onto the context, so the command cannot tell "my thread" from
  "the thread I named".

## What was built

* `proto/codefoundry/v1/thread.proto`, `thread_lifecycle.proto`: `rpc Wait`,
  `ThreadWaitCondition`, `WaitThreadRequest{id, until, timeout}`,
  `WaitThreadResponse{thread, timed_out}`. `events.proto`: `Event.seq`,
  `WatchEventsRequest.since_seq`. Generated Go and TS committed.
* `internal/api/thread_wait.go`: `Thread.Wait`: subscribe to `thread.Event`, then read
  the snapshot, then check on every `Updated` for the id (the event's thread, not a
  re-read: no ordering assumption between snapshot and publish); a drop re-reads the
  snapshot; `Removed` is NOT_FOUND. `threadWaitMet` is the condition table.
* `internal/command/commands_thread_wait.go`: `thread.wait`, registered in
  `RegisterThread`; `ThreadBackend` gains `Wait`.
* `internal/api/events_hub.go`: the hub. `internal/api/events.go`: sources declare
  `topics()` (bus topic + mapping, `busTopic` / `transientTopic`) instead of subscribing
  per stream; `Watch` joins the hub and reads its queues. `events_settings.go`,
  `action_events.go`, `update.go` (UpdateService.Watch uses `subscribeTopics`, its own
  per-stream subscription as before).
* `internal/client/client.go`: `Client.Events`.
* `cmd/code-foundry/events.go`: the `events` verb (listed in `code-foundry help` under
  built-in commands; the help has no groups).

## The event hub

* One hub per `Events` handler, started by the first Watch (`sync.Once`) and running
  until the daemon's Done: events published while no client is connected are still
  numbered and kept, so a client can disconnect and resume later.
* It subscribes every source's (non-transient) topics once. Each topic's goroutine
  maps the bus event to a `*v1.Event` and calls `publish`, which under one mutex
  stamps `seq`, appends to the ring (4096 `hubEvent`s; overwriting the oldest raises
  `floor`), and does a non-blocking send to every client that wants the source. The
  stamped event is shared by all streams and never modified again (protobuf marshal of
  a read-only message is safe concurrently; `-race` tests run two clients on it).
* `join(mask, since)` registers the client and copies the replay under the same lock as
  `publish`, so replay and live queue neither overlap nor leave a gap. Resumable iff
  `since > 0 && floor <= since <= seq`.
* Per client: one queue of 1024 kept events in seq order (so "the last seq I applied"
  is a valid resume point) and one of 64 transient events (an intent must not be crowded
  out by a flood of repo events; caught by `TestEventsResyncsSourceAfterDrops`). When a
  queue is full the client's dirty bit for that source is set and it is poked.
* Resync (slow client, per source as before): `Watch` takes the dirty bits, reads
  `lastSeq` *before* the snapshot, sends the snapshot, and then skips queued events of
  that source with seq ≤ that value (the store changed before it published, the hub
  numbered after it received, so the snapshot has them). Without the skip, stale queued
  events would be applied over the fresh snapshot. Transient events are never skipped.
* If the hub's own bus subscription drops (its 256-event buffer per topic overflows),
  every client resyncs the source and the log starts over: the hub burns one seq for
  the gap and sets `floor` to it, so no resume reaches across.
* Per-client source state: `terminalSource.known` (for the `removed_id` retractions of
  a terminal resync) is now fed by `observe` from what the stream delivers; on a resume
  it starts from the current terminal list.
* Order across sources is the hub's numbering order (topic goroutines race to the lock);
  within a topic it is publish order, as before.

## Gotchas

* A daemon restart resets the counter. A client whose `since` is above the new counter
  falls back to snapshots, but one whose `since` is below it (the new daemon already
  published more events than the old one had) would be "resumed" with unrelated events.
  A daemon epoch (start time or random id on the stream) would close this; left for a
  later PR. Clients should treat a daemon restart (their stream ended) as "start over".
* The `events` verb is in the local `subcommands` table, so `code-foundry events <word>`
  would be read as a daemon command named `events.<word>` (the dispatch rule for local
  verbs); there is none.
* The worktree-isolation hook refused a few e2e command lines (prompts passed
  positionally, `repo git init` as words); `--prompt`, `--text` and the dotted
  `repo.git.init` worked. The scratch repo got its git through the daemon
  (`repo.git.init`), not a shell `git init`.

## End to end (2026-10-17, isolated home, scratch repo under ~)

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-pr1 bin/code-foundry daemon --dev` (no
`CODE_FOUNDRY_ENDPOINT` in the environment, so the CLI used `/tmp/cf-pr1/daemon.sock`);
a folder `~/cf-scratch-pr1` with a README. `$CF` is `bin/code-foundry`, every command
with `CODE_FOUNDRY_HOME=/tmp/cf-pr1`. Output as printed.

```
$ $CF repo add ~/cf-scratch-pr1
registered cf-scratch-pr1 (f340408e54a8)
$ $CF repo.git.init --repo f340408e54a8
initialized git in cf-scratch-pr1 on main
$ $CF events --json > a.jsonl &          # client A, all sources
$ $CF thread.new --repo f340408e54a8 --model 'claude-haiku-5-5[1m]' --effort medium --name "wait e2e" \
    --prompt "Use your Bash tool to run: sleep 15. Then reply with the single word done."
created thread wait e2e (s-6c2fa93670c1) in /Users/alex/cf-scratch-pr1
$ time $CF thread.wait s-6c2fa93670c1          # busy: returns when the turn ends
thread s-6c2fa93670c1 wait e2e: needs attention (finished)
... 16.459 total
exit=0
$ $CF thread.items --id s-6c2fa93670c1
#1 you: Use your Bash tool to run: sleep 15. Then reply with the single word done.
#2 tool Bash [done] {"command":"sleep 15","description":"Sleep for 15 seconds"}
    → (Bash completed with no output)
#3 claude: done
#4 turn end: success, 18.9s, 46827 in / 85 out tokens, $0.0028, $0.0028 so far, claude-haiku-5-5
$ jq -c '{seq: (.seq // "0"), source: (keys - ["seq"])[0], status: .threadList.updated.status, reason: .threadList.updated.statusReason}' a.jsonl | tail -10
{"seq":"0","source":"action","status":null,"reason":null}
{"seq":"1","source":"threadList","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"2","source":"ui","status":null,"reason":null}
{"seq":"3","source":"threadList","status":"THREAD_STATUS_BUSY","reason":"working"}
...
{"seq":"8","source":"threadList","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"9","source":"threadList","status":"THREAD_STATUS_NEEDS_ATTENTION","reason":"finished"}
```

(seq 2 is thread.new's `focus_thread` intent: a transient event, numbered in the same
sequence.) Client A ended with exit 0 when the daemon stopped for the rebuild below.
After `daemon.restart` on the build with the final timeout wording (the counter starts
at 1 again):

```
$ $CF events --json --source thread-list > a.jsonl &                     # client A
$ sleep 8 | $CF events --source thread-list > b.txt; echo "exit=$?" >> b.txt &   # client B: its stdin closes after 8 s
$ $CF thread.send --id s-6c2fa93670c1 --text "Use your Bash tool to run: sleep 12. Then reply with the single word again."
sent to thread s-6c2fa93670c1
$ time $CF thread.wait s-6c2fa93670c1
thread s-6c2fa93670c1 wait e2e: needs attention (finished)
... 15.924 total
exit=0
$ cat b.txt                                    # B stopped mid-turn
- thread-list snapshot
1 thread-list updated s-6c2fa93670c1: busy (working)
2 thread-list updated s-6c2fa93670c1: busy (working)
3 thread-list updated s-6c2fa93670c1: busy (working)
4 thread-list updated s-6c2fa93670c1: busy (working)
exit=0
$ jq -c '{seq: (.seq // "0"), state: .threadList.updated.state, status: .threadList.updated.status, reason: .threadList.updated.statusReason}' a.jsonl
{"seq":"0","state":null,"status":null,"reason":null}
{"seq":"1","state":"THREAD_STATE_STARTING","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"2","state":"THREAD_STATE_STARTING","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"3","state":"THREAD_STATE_STARTING","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"4","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"5","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"6","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"7","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"8","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_NEEDS_ATTENTION","reason":"finished"}
$ sleep 2 | $CF events --source thread-list --since 4          # what B missed, no snapshot
5 thread-list updated s-6c2fa93670c1: busy (working)
6 thread-list updated s-6c2fa93670c1: busy (working)
7 thread-list updated s-6c2fa93670c1: busy (working)
8 thread-list updated s-6c2fa93670c1: needs attention (finished)
exit=0
$ sleep 2 | $CF events --source thread-list --since 4 --json | jq -c '{seq, status: .threadList.updated.status, reason: .threadList.updated.statusReason}'
{"seq":"5","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"6","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"7","status":"THREAD_STATUS_BUSY","reason":"working"}
{"seq":"8","status":"THREAD_STATUS_NEEDS_ATTENTION","reason":"finished"}
$ sleep 1 | $CF events --source thread-list --since 999         # ahead of the counter: snapshot
- thread-list snapshot
exit=0
$ time $CF thread.wait s-6c2fa93670c1 --until idle               # already idle: at once
thread s-6c2fa93670c1 wait e2e: needs attention (finished)
... 0.013 total
exit=0
$ $CF thread.wait s-6c2fa93670c1 --json | jq -c '{id, name, state, status, statusReason}'
{"id":"s-6c2fa93670c1","name":"wait e2e","state":"THREAD_STATE_CONNECTED","status":"THREAD_STATUS_NEEDS_ATTENTION","statusReason":"finished"}
$ time $CF thread.wait s-6c2fa93670c1 --until disconnected --for 3s
code-foundry: thread.wait: timed out after 3s waiting for thread s-6c2fa93670c1 to be disconnected; it is needs attention (finished) (deadline_exceeded)
... 3.014 total
exit=1
$ $CF thread.wait s-6c2fa93670c1 --for 25h
code-foundry thread.wait: 25h0m0s is out of range: give more than 0 and at most 24h
Run `code-foundry help thread.wait` for usage.
exit=2
$ $CF thread.wait s-nope
code-foundry thread.wait: thread s-nope not found
Run `code-foundry help thread.wait` for usage.
exit=2
$ $CF thread.remove --id s-6c2fa93670c1 --yes
removed thread s-6c2fa93670c1
$ $CF repo.unregister --repo f340408e54a8 --yes
unregistered f340408e54a8
```

Then the daemon was stopped (SIGTERM; client A ended with exit 0) and
`~/cf-scratch-pr1` and `/tmp/cf-pr1` deleted.
