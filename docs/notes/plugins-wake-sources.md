# Plugin wake sources (2026-10-18)

A plugin declares wake sources in its manifest; an agent's thread subscribes to one with
the existing wake engine (`docs/notes/agents-4-wake.md`); the plugin fires it. So an
agent that learns of an event from a plugin (checks failed, a deploy finished) waits for
the next one with `thread subscribe --plugin …` instead of polling. Design aligned with
Alex on 2026-10-18 (the brief); built on `origin/main` c6c05673.

## What is here

| Piece | Where |
|---|---|
| Manifest `wakes` (`WakeSpec`, `WakeArgSpec`, scopes, contexts, `ArgDuration`), validation, unknown-field warnings, `Manifest.Wake`, `WakeSpec.Arg`, `WakeArgSpec.Check` | `pluginsdk/wake.go`, `manifest.go` (field, `validateWakes` call, `jsonFieldNames`, `ReservedNames` + `wakes`) |
| Protocol | `wake/subscribed {subscription, source, args, context, repeat}` and `wake/unsubscribed {subscription, source}` (host → plugin notifications), `wake/fire {source, match, title, payload}` → `{delivered}` (request); capability `wakes` |
| SDK | `Plugin.OnWakeSubscribed`, `Plugin.OnWakeUnsubscribed` (`serve.go`); `Host.FireWake(ctx, source, match, title, payload)`, `Host.WakeHint`, `pluginsdk.WakeHint(plugin, source, args)`, `ParseWakeTarget`, `MatchWake`, `FormatWakeArgs` |
| plugintest | `pluginsdk/plugintest/wakes.go`: `SubscribeWake`, `SubscribeWakeWith`, `UnsubscribeWake`, `WakeSubscriptions`, `WakeFires`, `WakeDelivered`, `Options.Wakes` (refuses what the host would) |
| Proto | `ThreadSubscriptionTarget.PLUGIN = 4`, `ThreadSubscriptionCondition.FIRED = 20`, `ThreadSubscription.args = 20`, `SubscribeThreadRequest.target_plugin = 10` / `args = 11`, `UnsubscribeThreadRequest.target_plugin = 10`; `Plugin.wakes = 31` (`PluginWake`, `PluginWakeArg`, `subscribe_line`); `ArgSpec.repeatable = 11` |
| Migration | `0034_thread_subscription_args.sql`: `thread_subscriptions.args` (JSON object, `'{}'`) |
| Thread store | `internal/store/thread/subscriptions_plugin.go` (new): `TargetPlugin`, `CondFired`, `PluginWakes` (Resolve, Changed, Describe), `SetPluginWakes`, the ordered Changed queue, `FirePlugin`, `PluginWakesGone`, `PluginSubscriptions`, the message. Small edits in `subscriptions.go` (target parsing, args on `Subscription`/options, dedupe by args, plugin rows kept at startup, removals queue Changed, listing) and `subscriptions_db.go` |
| Plugin store | `internal/store/plugin/wakes.go` (new): `WakeSink`, `WakeSub`, `Options.Wakes`, `ResolveWake` (args, defaults, context), `WakeChanged`, `DescribeWake`, `WakeSubscribeLine`, arm at initialize, `wake/fire`, `endWakes` / `dropUndeclaredWakes` / `sweepWakes`. `forget` and `discard` take a reason; `apply` drops undeclared sources; the actor arms after `initialized` and disarms on exit |
| Daemon | `internal/daemon/plugin_wakes.go`: `threadPluginWakes` (thread.PluginWakes over the plugin store, errors mapped) and `pluginWakeSink` (plugin.WakeSink over the thread store); wired in `daemon.go` |
| API | `thread_subscriptions.go` maps target, condition, args; `plugin_wakes.go` maps `Plugin.wakes` |
| Commands / CLI | `thread subscribe --plugin <plugin>/<source> [--arg k=v …] [--repeat]`, `thread unsubscribe --plugin`, plugin rows in `thread subscriptions`; `plugin wakes [<name>] [--json]` (`commands_plugin_wakes.go`); WAKES column in `plugin list`; `command.ArgSpec.Repeatable` (the CLI joins a repeated flag's values with newlines; help says "(repeatable)") |
| Examples | `plugins/examples/hello`: `tick` (arg `every`, duration, default 10s; one loop per distinct every) and `fire-tick`; `internal/store/plugin/testdata/pyecho`: wake source `bell` and `ring` (wake/fire without the SDK) |
| Skills | plugin skill: `SKILL.md` (wake sources in the intro and a Good-to-know rule), `manifest.md` "Wakes", `host-api.md` "FireWake", `protocol.md` rows, `testing.md` (plugintest and daemon). Orchestrate skill: one Conventions rule |

## Decisions

From the brief:

* **Manifest**: `wakes: [{name [a-z0-9-]{1,64}, title, description, args, scope}]`,
  validated at load, listed in `plugin list` (WAKES) and the Plugin proto. No new
  permission: a wake only reaches threads that asked for it.
* **Target** `PLUGIN`, `target_id = "<plugin>/<source>"`, `args` persisted. Condition
  "fired". One-shot by default, `--repeat` for every fire. The 60/hour cap and the cleanup
  on archive/remove apply (they are the engine's).
* **Context args** default from the subscriber: `thread` its id, `project` its project
  (the thread store's, else the facts'), `pr` its pull request `owner/name#123` (the first
  of `ThreadFacts.PullRequests`: its branch's, an open one first). A required arg without
  a value is InvalidArgument naming it.
* **Match**: a subscription is woken when each of its args equals the fire's match
  value (a subscription with fewer args matches more broadly). Match names must be the
  source's args.
* **Delivery**: `[code-foundry wake] <display name>: <source> — <title>` and
  `{kind: "plugin", subscription_id, plugin, source, args, title, payload, fired_at}`;
  `wake_title` is the header without the prefix.
* **Source gone**: disable, uninstall, takeover (another source's `plugin dev --force` /
  install), permission growth, a package removed from the folder, and an update or dev
  edit that drops a source: each live subscription gets one last wake `… — source gone
  (<reason>)` with `payload: null` and is deleted.
* **Re-arm**: `wake/subscribed` for every live subscription right after each
  `initialized` (a plugin restart, a crash's restart, a daemon restart).
* **Discovery**: `plugin wakes` and the skills, not the agent guide.

Decided while building (flagged for review):

* **Beside the pull request target** (`gh-events-3-pr-wake.md`, merged as #214 while this
  was in review; rebased on it): PLUGIN is 4 (PULL_REQUEST 3), FIRED is 20 (the pull
  request conditions 7 to 16), `target_plugin`/`args` are 10/11 (`target_pull_request`
  6 and 5), `ThreadSubscription.args` 20. `subscribeTarget`, `removeLocked`, the threadtest
  fake and the command take all four targets. The `pr` context arg uses its
  `owner/name#123` lower-case form, so a plugin source and a pull request subscription
  name a pull request the same way.
* **No fire at subscribe time** for a plugin target (the host does not know the event's
  state; the plugin may fire at once from `OnWakeSubscribed` if it does).
* **Subscriptions survive a daemon restart** (unlike run targets): the plugin re-arms.
  At startup a plugin that is not installed or not enabled loses its subscriptions with
  the source-gone wake (`sweepWakes`), as do sources an enabled plugin no longer declares.
* **Subscribing needs the plugin enabled**, not running: a crashed plugin re-arms when it
  comes back. A broken manifest keeps the subscriptions (it may be fixed).
* **The same subscription twice** (subscriber, target, args) returns the existing one.
* **Ordering**: the thread store queues Changed calls under its lock and makes them from
  one goroutine outside it; the plugin store sends them only once the plugin is armed,
  under the actor's wake mutex, which the arm (list + send) also holds, so a plugin
  never sees a subscription after its unsubscription. Notes made before the arm are
  dropped: the arm's list has them.
* **`until`**: a plugin target takes no `--until` (settled, the default, stands for
  fired; "fired" is not in the CLI's enum, to keep the guide under its cap). Values are
  trimmed; `--arg k=v` with `=` in the value keeps the rest.
* **`pr` values** may be given as `owner/name#123`, `#123` / `123` (the thread's pull
  request's repository, else its project's GitHub slug) or a pull request URL.
* **Limits**: title one line, ≤ 200 characters; payload ≤ 8 KiB of JSON; ≤ 20 fires a
  second per plugin (CodeRateLimited); arg values one line ≤ 512 bytes; ≤ 50 sources, ≤
  16 args each.
* **Repeatable flags** are a small generic addition (`ArgSpec.repeatable`): only
  `thread.subscribe --arg` uses it. The guide leaves repeatable args out with `--plugin`
  (`guideShowsArg`).
* `plugin.wakes` is NoKeybinding; `wakes` joined the reserved plugin names.

## Tests

* SDK (`pluginsdk/wake_test.go`): manifest table (names, scopes, types, contexts,
  defaults, limits), unknown wake fields, `Check`, `WakeHint` (sorting, quoting),
  `ParseWakeTarget`, `MatchWake`, `FormatWakeArgs`; `jsonFieldNames` covers the new types.
  plugintest (`wakes_test.go`, `SubscribeWake`, `WakeFires`, …: named apart from the event `Subscriptions()`): arm/disarm, match, one-shot removal, undeclared source,
  payload and title limits.
* Thread store (`subscriptions_plugin_test.go`): target parsing table, the message, fires
  with match semantics and one-shot vs repeat, Changed order, existed, refusals, listing,
  re-arm list across a restart, unsubscribe by target, archive cleanup, context args per
  subscriber, source gone (one source, all, persisted), the wake cap.
* Plugin store (`wakes_test.go`, helper mode `wakes`): `ResolveWake` table (defaults,
  given, bad, unknown arg, pr from the thread, `#n` / `n` / URL, no repository, required
  missing, thread and project context, unknown plugin, disabled, unknown source),
  `DescribeWake`, `WakeSubscribeLine`; arm and fire (checks, display name, log line,
  re-arm after restart); source gone at startup, on update, disable, uninstall and
  removal. `TestPythonPlugin` arms and fires over the bare protocol.
* Daemon (`plugin_wakes_test.go`), API (`thread_subscriptions_plugin_test.go`),
  commands (`commands_thread_subscribe_test.go`, `commands_plugin_wakes_test.go`), CLI
  (`argsource_test.go`: a repeated flag), migration, `plugins/examples/hello/wakes_test.go`.

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=~/.cf-wake-e2e`)

`make build plugins`; the branch binary as `code-foundry` with that home; `daemon --dev`.
One Haiku 5.5 thread, three turns in all ($0.0036).

````
$ code-foundry plugin dev plugins/examples/hello --yes
linked …/plugins/examples/hello as dev plugin hello; enabled hello 0.1.0 (starting)
$ code-foundry plugin list
NAME   VERSION  STATE          PERMISSIONS                                    COMMANDS  SURFACES                           WAKES  NOTE
hello  0.1.0    running (dev)  commands(thread.send,pr.checks) events(threads) …  9   demo(off) pinned(off) checks(off)  tick
$ code-foundry plugin wakes hello
hello/tick — Tick (scope global)
  Fires every <every> while a thread is subscribed (once without --repeat); the payload has the tick count. A demo of wake sources.
  --arg every=… (duration, default 10s): How often it fires
  code-foundry thread subscribe --plugin hello/tick
$ code-foundry thread new --no-project --name "wake e2e" --model 'claude-haiku-5-5[1m]' --effort medium --created-by=
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tock
code-foundry thread.subscribe: not found: plugin hello has no wake source "tock" (it has tick; code-foundry plugin wakes hello)
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg every=soon
code-foundry thread.subscribe: invalid argument: every: want a duration over zero (10s, 1m30s), got "soon"
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg often=1s
code-foundry thread.subscribe: invalid argument: hello/tick has no arg "often"
$ code-foundry thread subscribe --id s-d71711e5864a --plugin nope/tick
code-foundry thread.subscribe: not found: no plugin "nope" (code-foundry plugin list)
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --until idle
code-foundry thread.subscribe: a plugin's wake source fires when the plugin fires it; leave until out (not idle)
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg every=2s
subscribed sub-8d9f223900a5: s-d71711e5864a wakes when plugin hello/tick fires (every=2s) (once)
$ code-foundry thread subscriptions --id s-d71711e5864a
ID                SUBSCRIBER                 TARGET                                    UNTIL  REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-8d9f223900a5  s-d71711e5864a (wake e2e)  plugin hello/tick every=2s (Hello: Tick)  fired  no      0      -           running
$ sleep 12; code-foundry thread subscriptions --id s-d71711e5864a   # the one-shot fired and went
thread s-d71711e5864a has no wake subscriptions
$ code-foundry thread items --id s-d71711e5864a      # the stopped thread started with the wake
#1 wake: Hello: tick — tick 1 (every 2s)
#2 thinking
#3 claude: Tick 1 of the `hello` plugin subscription (`sub-8d9f223900a5`) arrived at 2026-10-19T02:07:54Z. It has no request attached, so I haven't changed anything. …
#4 turn end: success, 2.2s, 24812 in / 274 out tokens, $0.0027, $0.0027 so far, claude-haiku-5-5
$ code-foundry thread items --id s-d71711e5864a --json | jq -r '.items[] | select(.userMessage.origin == "MESSAGE_ORIGIN_WAKE") | .userMessage.text'
[code-foundry wake] Hello: tick — tick 1 (every 2s)
```json
{
  "kind": "plugin",
  "subscription_id": "sub-8d9f223900a5",
  "plugin": "hello",
  "source": "tick",
  "args": { "every": "2s" },
  "title": "tick 1 (every 2s)",
  "payload": { "at": "2026-10-19T02:07:54Z", "every": "2s", "n": 1 },
  "fired_at": "2026-10-19T02:07:54.654Z"
}
```
````

Repeat, the same subscription again, re-arm on a plugin restart, `fire-tick`, disable:

```
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg every=1h --repeat
subscribed sub-766c815f87cc: s-d71711e5864a wakes when plugin hello/tick fires (every=1h) (repeat)
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg every=1h --repeat
already subscribed sub-766c815f87cc: s-d71711e5864a wakes when plugin hello/tick fires (every=1h) (repeat)
$ code-foundry plugin restart hello
$ code-foundry plugin logs hello | grep -E 're-armed|tick armed'
21:08:14.970 log info   tick armed every=1h subscription=sub-766c815f87cc
21:08:15.008 host       re-armed 1 wake subscriptions
21:08:15.008 log info   tick armed every=1h subscription=sub-766c815f87cc
$ code-foundry plugin hello fire-tick
fired tick for every=1h: woke 1
Wait for the next one: code-foundry thread subscribe --plugin hello/tick --arg every=1h
$ code-foundry plugin hello fire-tick --every 1h
fired tick for every=1h: woke 1
Wait for the next one: code-foundry thread subscribe --plugin hello/tick --arg every=1h
$ code-foundry thread subscriptions --id s-d71711e5864a
ID                SUBSCRIBER                 TARGET                                    UNTIL  REPEAT  FIRED  LAST FIRED  TARGET STATUS
sub-766c815f87cc  s-d71711e5864a (wake e2e)  plugin hello/tick every=1h (Hello: Tick)  fired  yes     2      21:08:17    running
$ code-foundry plugin disable hello
disabled hello
$ code-foundry thread subscriptions --id s-d71711e5864a
thread s-d71711e5864a has no wake subscriptions
$ sleep 20; code-foundry thread items --id s-d71711e5864a | tail -8
#5 wake: Hello: tick — tick 1 (every 1h)
#6 wake: Hello: tick — tick 2 (every 1h)
#7 wake: Hello: tick — source gone (the plugin was disabled)
#8 claude: Tick 1 of a second `hello` subscription (`sub-766c815f87cc`, every 1h) arrived at 2026-10-19T02:08:17Z. …
#9 turn end: success, 1.6s, 25310 in / 176 out tokens, $0.0004, $0.0031 so far, claude-haiku-5-5
#10 thinking
#11 claude: The `hello` plugin was disabled at 2026-10-19T02:08:17Z. Tick 2 of `sub-766c815f87cc` (every 1h) arrived just before that, and the following wake reports its so…
#12 turn end: success, 2.2s, 25873 in / 293 out tokens, $0.0005, $0.0036 so far, claude-haiku-5-5
$ … | jq -r '[.items[] | select(.userMessage.origin == "MESSAGE_ORIGIN_WAKE")] | last | .userMessage.text'
[code-foundry wake] Hello: tick — source gone (the plugin was disabled)
{ "kind": "plugin", "subscription_id": "sub-766c815f87cc", "plugin": "hello", "source": "tick",
  "args": { "every": "1h" }, "title": "source gone (the plugin was disabled)", "payload": null,
  "fired_at": "2026-10-19T02:08:17.097Z" }
$ code-foundry plugin logs hello | grep -E 'wake|tick'
21:07:52.651 host       wake subscription sub-8d9f223900a5 to tick by s-d71711e5864a (every=2s)
21:07:54.656 host       wake tick fired (every=2s): woke 1
21:07:54.656 host debug wake subscription sub-8d9f223900a5 to tick ended
21:07:54.657 log info   tick stopped every=2s
21:08:17.046 host       wake tick fired (every=1h): woke 1
21:08:17.064 host       wake tick fired (every=1h): woke 1
21:08:17.097 host       ended 1 wake subscriptions (the plugin was disabled)
```

A daemon restart keeps a subscription and re-arms the plugin; unsubscribe by target:

```
$ code-foundry plugin enable hello
$ code-foundry thread subscribe --id s-d71711e5864a --plugin hello/tick --arg every=1h --repeat
subscribed sub-2511ce479c02: s-d71711e5864a wakes when plugin hello/tick fires (every=1h) (repeat)
# SIGTERM to the daemon, start it again
$ code-foundry thread subscriptions --all
sub-2511ce479c02  s-d71711e5864a (wake e2e)  plugin hello/tick every=1h (Hello: Tick)  fired  yes  0  -  running
$ code-foundry plugin logs hello | grep -E 're-armed|tick armed'
21:08:48.085 host       re-armed 1 wake subscriptions
21:08:48.086 log info   tick armed every=1h subscription=sub-2511ce479c02
$ code-foundry thread unsubscribe --id s-d71711e5864a --plugin hello/tick
removed sub-2511ce479c02: s-d71711e5864a wakes when plugin hello/tick fires (every=1h) (repeat)
$ code-foundry plugin logs hello --lines 10 | grep tick
21:08:56.425 host debug wake subscription sub-2511ce479c02 to tick ended
21:08:56.425 log info   tick stopped every=1h
```

No ERROR lines in either daemon log. Then the daemon was stopped and `~/.cf-wake-e2e` and
the thread's transcript deleted.

## Gotchas

* **The agent guide is at 28,996 bytes** of its 29,000 cap (after the rebase on the pull
  request target, which also grew it). `thread.subscribe`'s description dropped "(default:
  the thread this runs in)" (the `--id` flag says it) to make room for "or a plugin wake
  fires (plugin wakes)". The next command that touches the guide needs to cut something.
* `SKILL.md` of the plugin skill is at its 120-line cap.
* Three wakes delivered within a second into a stopped thread became two turns: the
  first starts Claude, the next two were queued behind it and answered together.
* zsh does not split `$args` in a loop: the e2e ran from bash scripts.

## Open

* Not exercised live: takeover and uninstall (unit tests), a `pr` context with a real
  pull request (unit tests with fake facts), the 20/s fire limit.
* No GUI: the wake item already renders as a user message with `origin` WAKE; the
  thread subscriptions have no GUI surface yet.
* The gh-actions and test-watcher plugins can now advertise sources (`checks-done`,
  `tests-finished`) and end their messages with `WakeHint`; not done here.

## Daemon restart

Needed: migration 0034, new RPC fields and commands, the plugin protocol methods.

Follow-up: `plugins-wake-polish.md` (pluginsdk v0.2.1): handlers wait for Init, `rearm`
and `wake/armed`, wake hints never in flag reasons, the SDK pin uses the tag.
