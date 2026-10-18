# Plugins 3: event subscriptions, thread flags, session environment (2026-10-18)

The third PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row 3),
based on `cf/plugins-1-core` and built beside PR 2 (surfaces); it will be rebased onto PR 2.
Three protocol methods go live: `events/subscribe` (+ `events/unsubscribe`, `events/event`),
`thread/setFlag` and `session/setEnvironment`. Their handlers register themselves in
`hostMethods` from `init()` in new files, so `host.go` is untouched (its `laterMethods`
list still names them; the registry is checked first).

## What is here

| Piece | Where |
|---|---|
| Thread flags (store, persistence, clearing) | `internal/store/thread/flags.go`, migration `0030_plugin_flags_env.sql` (`thread_flags`), archive and viewer hooks in `archive.go` / `items.go` |
| Spawn extras (the plugins' env, PATH, add-dirs in `claudeCommand`) | `internal/store/thread/spawnextras.go`, `claudeCommand` in `manager.go` |
| Plugin side: flags, events, environment | `internal/store/plugin/flags.go`, `events.go`, `environment.go` (+ `plugin_environments` in the same migration) |
| The daemon's glue (neither store imports the other) | `internal/daemon/plugin_hooks.go` (`pluginFlags`, `pluginSpawnExtras`), wiring in `daemon.go` |
| API | `Thread.flags` + `ThreadService.ClearFlags` (`api/thread_flags.go`), `PluginService.Environment` (`api/plugin_env.go`), `api.PluginFeed` (`api/plugin_feed.go`); `Events.Watch` now runs `Events.stream`, which the feed shares |
| CLI | `thread flags <id>`, `thread flag clear <id> [--plugin]` (`commands_thread_flags.go`), `plugin env [<name>]` (`commands_plugin_env.go`) |
| SDK | `InitializeParams.Flags` + `Host.Flags()`, `Flag.SetAt`, `FlagResult`, `Conn.Queued()`, `env` reserved as a plugin name |
| GUI | `ThreadView.flags` (`api/threads.ts`), `topFlag` + `threadGroup` (`lib/thread.ts`), `flagAttention` / `flagError` line-2 kinds (`lib/statusLine.ts`), `isAttention` (`stores/threads.ts`), lineage words; mock `POST /__mock/thread/flag`, `e2e/plugin-flags.spec.ts`, `src/api/threadFlags.test.ts` |
| Example | `plugins/examples/hello`: pushes `CF_HELLO=1` (every project and threads without one), subscribes to `threads`, logs events, `flag` and `events` commands |

## Decisions

* **Flags live in the thread store**, as `Thread.Flags` (source = the plugin's name, opaque
  to the store, plus its display name at set time), so they ride the existing thread list
  events to the sidebar, the dock and `thread get` with no new stream. The plugin store
  reaches them through `plugin.ThreadFlags`, which the daemon adapts.
* **Persisted** (`thread_flags`, cascading with the thread), per the PR brief. The design
  (§C.6) said in memory only, re-raised by the plugin after a restart; a persisted flag
  needs its own clearing, so: the plugin clears it (`level: none`), disabling, a
  permission-change disable or the package vanishing clears all of its flags, and the
  plugin store's `Start` sweeps flags (and saved environments) of plugins that are not
  enabled (disabled or removed while the daemon was stopped). `initialize` hands the
  plugin its live flags (`InitializeParams.flags`, `Host.Flags()`) to reconcile.
* **Clearing on archive** (brief), not "kept but never counted" (§C.6). Setting a flag on
  an archived thread is refused (`-32002`).
* **Until seen** reuses the finished-turn acknowledge points: a `WatchItems` (the visible
  thread's `WatchThread`) clears them when it opens, and an until-seen flag set while
  someone watches is seen at once, so it is not stored (`changed: false`). Any
  `ThreadService.WatchThread` client counts, not only the GUI (the same as for a finished
  turn).
* **Limits**: one flag per (thread, plugin); reason one line, 1..80 characters; a plugin
  may raise at most one flag a second on a thread (clearing is never limited); an
  identical flag is no change (keeps `set_at`).
* **GUI effective status**: `threadBadge` stays the stream's. A flag changes the sort group
  (`threadGroup`: Claude's prompt > error/interrupted > error flag (error group) >
  attention flag (prompt group) > finished > working/idle; a busy flagged thread leaves
  Working), line 2 (`statusLine`: Claude's prompts and errors win, then the top flag as
  "<display name>: <reason>" in amber or red, which wins over "Finished" and "Working"),
  the tooltip (unchanged rule: amber and red rows show it) and `isAttention` (any flag,
  both levels, per the brief: bell, window title, dock badge and bounce with the shared
  cooldown, `cmd+shift+a`). The design said error flags do not ring; the brief overrides.
* **Event feed**: `api.Events.stream` is Watch's loop (snapshots, live events from the
  hub, per-source resync), with an output that is the gRPC stream for Watch and a
  plugin queue for `PluginFeed`. Events are `protojson.Marshal` of `codefoundry.v1.Event`
  (lowerCamel, `seq` and `epoch` included). Source names are the manifest's
  (`pluginsdk.EventSources`: project, workspace, threads, thread, gh, gitops, settings,
  update, action, plugin); never `ui` or `terminal`. Each subscribed source must be in the
  grant's `permissions.events` (`-32001` otherwise); at most 16 subscriptions at once.
* **Backpressure**: one queue per running plugin (2048 events / 8 MiB). The feed never
  waits: when the queue is full the oldest event goes, counted, with a plugin log line
  and a daemon `WARN` at most once a second ("events: dropped N events (M in all): the
  plugin is not keeping up; resending the snapshot of threads"), and the dropped event's
  source gets its snapshot again (`snapshot: true`) once the queue drains. The writer holds
  back while the plugin's stdin queue (pluginsdk's 4 MiB, which restarts a plugin that
  fills it) holds more than 1 MiB. Subscriptions end with the process.
* **Session environment** as §C.7 minus MCP servers (DECISIONS): env (reserved
  `CODE_FOUNDRY_*`, `CLAUDE_CODE_*`, `CLAUDECODE`, `CLAUDE_CONFIG_DIR`, `CLAUDE_EFFORT`,
  `PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`; names `[A-Za-z_][A-Za-z0-9_]*`; values text,
  ≤ 8 KiB; ≤ 64 keys), `pathPrepend` (absolute after `~/` expansion, under home, no `:`,
  ≤ 16), `addDirs` (existing directories under home, ≤ 16), `scope {projects, noProject}`.
  What fails a rule is dropped with an issue; the rest applies (`applied: true`). An empty
  push withdraws. Logs carry keys, never values. The last push per plugin is in
  `plugin_environments` and loaded before the plugins start.
* **Conflicts**: plugins apply in name order; a key an earlier plugin sets is dropped from
  the later one with an issue ("env X is also set by plugin a, which applies first"). The
  check is global, not per scope (two plugins scoped to different projects setting the same
  key still get the issue). PATH and add-dir duplicates are merged silently.
* **Spawn path**: `claudeCommand(ctx, s, l, g, wait)` asks `Manager.SetSpawnExtras`'s
  function (set by the daemon once the plugin store exists): `--add-dir` order skills dir,
  plugin add-dirs, attachments dir, workspace members, grants; env after `Options.Env` and
  the workspace env; `PATH=<plugin dirs>:<PATH>` (the daemon's PATH, or the last one the
  spawn's env set). Scope gets the thread's project, the workspace's member projects, and
  `NoProject` for a home thread. `spawn` (create, start on send, fork, reconnect) passes
  `wait`; the effort restart's `respawn` never waits and re-reads the current
  contribution. Naming (`--safe-mode`) and shells get nothing. A plugin add-dir gone since
  the push is skipped with a warning.
* **The 2 s wait**: only for an enabled plugin granted `sessionEnv` that is starting or
  running and whose current run has neither pushed nor settled (500 ms after
  `initialized`, its Init's time); a crashed plugin is not waited for. On expiry the spawn
  goes ahead with the saved contribution and logs a warning.
* **`plugin env`** shows values (the thread sees them in its environment anyway), issues,
  scope and push time. `env` joined the reserved plugin names so `plugin env` cannot clash
  with a plugin called env.
* **Guide**: `thread.flags` and `thread.flag.clear` are left out of the agent guide like
  the `plugin.*` namespace (`guide.InPluginNamespace`): the guide was at 28,9xx bytes of its
  29,000 budget.

## Gotchas

* `claude-4.5-haiku[1m]` (the Bedrock id from the model registry) answers "There's an issue
  with the selected model" on this machine; the end to end used `claude-haiku-5-5[1m]`.
* A thread started while the plugin was enabled keeps `CF_HELLO=1` after the disable (env
  is fixed at exec); only a new spawn drops it. That is the design ("running threads keep
  what they spawned with"), but easy to mistake for a bug when testing with `thread send`.
* Events may reach `OnEvent` before `Subscribe` returns (the snapshot is queued as soon as
  the subscription exists).
* Flag `set_at` has millisecond precision; two flags set within one millisecond sort by
  source name.
* The test plugin's `Conn` must not read from an exhausted reader (`strings.NewReader("")`
  closes it at once, and every write then fails): the pump tests use a pipe.

## Try it

```
make build plugins
export CODE_FOUNDRY_HOME=/tmp/cfp3      # never without it
./bin/code-foundry daemon --dev &
./bin/code-foundry plugin dev plugins/examples/hello --yes --follow=false
./bin/code-foundry plugin env hello
./bin/code-foundry plugin logs hello --lines 10
./bin/code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --prompt 'Run printenv CF_HELLO with Bash'
./bin/code-foundry plugin hello flag --context-thread <id> --level attention --reason "deploy needs approval"
./bin/code-foundry thread flags <id>
./bin/code-foundry plugin disable hello
```

## End to end

2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cfp3`, the daemon started without the
calling session's `CLAUDE*` variables, `code-foundry` a wrapper for the branch binary with
that home. Test threads ran Haiku 5.5 without a project (hello's scope includes them).

```
$ code-foundry plugin dev plugins/examples/hello --yes --follow=false
linked /Users/alex/projects/code-foundry.worktrees/plugins-3/plugins/examples/hello as dev plugin hello; enabled hello 0.1.0 (starting)
commands: code-foundry plugin hello greet, code-foundry plugin hello send, code-foundry plugin hello remember, code-foundry plugin hello recall, code-foundry plugin hello forget, code-foundry plugin hello flag, code-foundry plugin hello events
$ code-foundry plugin list
NAME   VERSION  STATE          PERMISSIONS                                                            COMMANDS  NOTE
hello  0.1.0    running (dev)  commands(thread.send) events(threads) threadStatus sessionEnv secrets  7         
$ code-foundry plugin env hello
plugin hello
  scope: every project, and threads without a project
  env CF_HELLO=1
  pushed: 2026-10-18 06:11:30
$ code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --name "Env check" --prompt 'Run exactly this shell command with the Bash tool and reply with its output only: printenv CF_HELLO || echo unset'
created thread Env check (s-5d73837b10f4) in /Users/alex (no project)
$ code-foundry thread read s-5d73837b10f4
#1 you: Run exactly this shell command with the Bash tool and reply with its output only: printenv CF_HELLO || echo unset
#2 tool Bash [done] {"command":"printenv CF_HELLO || echo unset","description":"Print CF_HELLO env var or fallback to unset"}
    → 1
#3 thinking
#4 claude: 1
#5 turn end: success, 4.1s, 47955 in / 155 out tokens, $0.0024, $0.0024 so far, claude-haiku-5-5
$ code-foundry plugin logs hello --lines 9
06:11:30.815 log info   subscribed to the thread list subscription=sub-1
06:11:30.817 log info   event kind=threadList.snapshot n=1 snapshot=true
06:11:35.595 log info   event kind=threadList.updated n=2 snapshot=false
06:11:36.215 log info   event kind=threadList.updated n=3 snapshot=false
06:11:36.477 log info   event kind=threadList.updated n=4 snapshot=false
06:11:38.273 log info   event kind=threadList.updated n=5 snapshot=false
06:11:40.326 log info   event kind=threadList.updated n=6 snapshot=false
06:11:40.326 log info   event kind=threadList.updated n=7 snapshot=false
06:11:40.427 log info   event kind=threadList.updated n=8 snapshot=false
log file: /tmp/cfp3/logs/plugins/hello.log
$ code-foundry plugin hello flag --context-thread s-5d73837b10f4 --level attention --reason "deploy needs approval"
attention flag on s-5d73837b10f4: deploy needs approval
$ code-foundry plugin hello flag --context-thread s-5d73837b10f4 --level error --reason "deploy failed"   # within a second
code-foundry: plugin.hello.flag: thread/setFlag: at most one flag a second on a thread (unknown)
$ code-foundry plugin hello flag --context-thread s-nope --reason x
code-foundry: plugin.hello.flag: thread not found: s-nope (unknown)
$ code-foundry thread flags s-5d73837b10f4
PLUGIN  LEVEL      REASON                 SET                  UNTIL SEEN
hello   attention  deploy needs approval  2026-10-18 06:11:45  no
$ code-foundry thread get s-5d73837b10f4 | grep flags
flags: hello attention: deploy needs approval
$ code-foundry thread flags s-5d73837b10f4 --json
{"flags":[{"plugin":"hello","pluginDisplayName":"Hello","level":"attention","reason":"deploy needs approval","setAt":"2026-10-18T11:11:45.186Z","untilSeen":false}],"threadId":"s-5d73837b10f4"}
$ code-foundry plugin disable hello
disabled hello
$ code-foundry thread flags s-5d73837b10f4
thread Env check (s-5d73837b10f4) has no flags
$ code-foundry plugin env
no plugin adds anything to new threads
$ code-foundry plugin logs hello --lines 4
06:11:45.379 host       stopped
06:11:45.380 host       session environment dropped: new threads no longer get it
06:11:45.380 host       cleared its flags on threads: 1
06:11:45.380 host       disabled
log file: /tmp/cfp3/logs/plugins/hello.log
$ code-foundry thread new --no-project ... --name "Env check after disable" --prompt 'Run exactly this shell command with the Bash tool and reply with its output only: printenv CF_HELLO || echo unset'
created thread Env check after disable (s-0850073f7cbc) in /Users/alex (no project)
$ code-foundry thread read s-0850073f7cbc | tail -3
#3 thinking
#4 claude: unset
#5 turn end: success, 3.9s, 47956 in / 141 out tokens, $0.0010, $0.0010 so far, claude-haiku-5-5
$ code-foundry plugin enable hello
enabled hello 0.1.0 (starting)
commands: code-foundry plugin hello greet, code-foundry plugin hello send, code-foundry plugin hello remember, code-foundry plugin hello recall, code-foundry plugin hello forget, code-foundry plugin hello flag, code-foundry plugin hello events
$ code-foundry plugin hello flag --context-thread s-0850073f7cbc --level error --reason "tests failed"
error flag on s-0850073f7cbc: tests failed
$ code-foundry thread archive --id s-0850073f7cbc && code-foundry thread flags s-0850073f7cbc
archived thread Env check after disable (s-0850073f7cbc)
thread Env check after disable (s-0850073f7cbc) has no flags
$ code-foundry plugin hello flag --context-thread s-0850073f7cbc --reason again
code-foundry: plugin.hello.flag: thread/setFlag: at most one flag a second on a thread (unknown)
$ code-foundry plugin hello flag --context-thread s-0850073f7cbc --reason again   # a second later
code-foundry: plugin.hello.flag: failed precondition: thread s-0850073f7cbc is archived (unknown)
```

GUI (built app, `make gui-build`, same home, window picked by its unix id): with an
attention flag on "Env check" (also an unseen finished turn) and an error flag on "Ship the
release notes", both rows sit in the attention group, line 2 reads "Hello: deploy needs
approval" in amber and "Hello: release build failed on macos-14" in red, the bell says 2
(dark and light screenshots in the PR body). Disabling hello cleared both rows. A thread
spawned before the disable still printed `1` for `printenv CF_HELLO` (its env is fixed at
exec); the one spawned after printed `unset`.

The transcripts of the test threads (`~/.claude/projects/-Users-alex/*.jsonl`) were removed
afterwards.

## Open for PR 5 (GUI) and PR 6 (threads, terminals)

* PR 5: the GUI has no plugin store yet, so a flag carries the plugin's display name as of
  set time; Settings → Plugins could show `plugin env` (contribution, issues) and the
  flags a plugin holds. No click-through from a flagged row to the plugin's surface. The
  thread header does not show flags (only the sidebar row, its tooltip, the bell and the
  dock). A "restart to pick up" hint for running threads after an env change is not built.
* PR 5: `Plugin.env_keys` (D.1) is not in the proto; `PluginService.Environment` replaces it.
* PR 6: plugin-owned threads are hidden from the sidebar; their flags (if a plugin flags
  its own thread) would count in `attentionIds` unless PR 6 filters hidden threads there.
  `thread/create`'s own `env`/`addDirs` should go through the same spawn extras path
  (per-thread, on top of the plugin's session environment).
* PR 6: bottom-panel shells still get no session environment (§C.7 open question 5).
* The `laterMethods` list in `host.go` still names the three methods (harmless; drop it
  when PR 2's rebase touches that list anyway).
* The migration is `0030` (renumbered from `0029` when the stack was rebased onto main, whose `0028_thread_name_provisional.sql` took 0028; `Thread.flags` likewise moved from proto field 53 to 54).
