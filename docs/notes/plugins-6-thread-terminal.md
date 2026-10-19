# Plugins 6: plugin-owned threads and terminals (2026-10-18)

The sixth PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row 6),
on `cf/plugins-5-gui`. A plugin can now run Claude threads and terminals of its own and
show them in its surfaces with `thread` and `terminal` nodes; a `surface/act` carries the
acting panel's context.

## What is here

| Piece | Where |
|---|---|
| SDK: `thread/create|send|archive|list`, `terminal/create|close|list`, `SurfaceAct.Context` | `pluginsdk/protocol.go`, `host.go` (`CreateThread`, `SendThread`, `ArchiveThread`, `Threads`, `CreateTerminal`, `CloseTerminal`, `Terminals`) |
| View model: `Height` (`auto` / `fill` / px) on both nodes, `terminal.actions` (up to 2) | `pluginsdk/ui/ui.go`, `validate.go` |
| Fake host | `pluginsdk/plugintest/owned.go` (`CreatedThreads`, `ThreadSends`, `PluginThreads`, `SetThread`, `CreatedTerminals`, `PluginTerminals`, `ExitTerminal`) |
| Owned threads in the thread store | `internal/store/thread/owner.go`; `Thread.Owner`, `SpawnEnv`, `SpawnAddDirs`; `CreateOptions.Owner`, `Cwd`, `Env`, `AddDirs`; `ListOptions.Owner`; migration `0032_thread_owner.sql` |
| Plugin side | `internal/store/plugin/threads.go`, `terminals.go`; `Options.Threads`, `Options.Terminals`; forget/sweep in `environment.go`; owned-node check in `surface_act.go` |
| Daemon glue | `internal/daemon/plugin_owned.go` (`pluginThreads`, `pluginTerminals`), `plugin_hooks.go` (owner in the spawn scope) |
| Terminal labels | `internal/termlabel` (`KindPlugin`, `Plugin`, `Title`, `PluginTerminal`), `gui/frontend/src/lib/termlabel.ts` |
| Proto | `Thread.owner = 55`, `ThreadFilter.owner = 10`, `SurfaceActRequest.context = 8` |
| CLI | `thread list --plugin <name>|*`, `plugin threads <name>`, `plugin terminals <name>`; `plugin act` sends its `--context-*` as the act's context |
| GUI | `components/plugin/nodes/ThreadNode.tsx`, `TerminalNode.tsx`, `OwnedGone.tsx`, `components/plugin/height.ts`; `components/thread/InlineThread.tsx`, `activity.ts`; `stores/thread.ts` (watches by thread), `stores/threads.ts` (`owned`), `stores/pluginTerminals.ts`, `stores/terminals.ts` (`shownIn`) |
| Example | `plugins/examples/hello/owned.go`: the demo's Assistant and Shell tabs |
| Fixtures | `internal/store/plugin/testdata/hello-demo/{overview,form,log,assistant,shell}.json` (recaptured); the mock's `s-hello-assistant` thread and `t-hello-clock` terminal |
| Skill | `internal/skills/files/code-foundry-plugin`: host-api (own threads and terminals), primitives (the two nodes, act context), protocol, manifest |

## Decisions

* **An owner tag on the thread, not a new kind of thread.** `threads.owner` is
  `plugin:<name>` (an opaque `kind:name` tag to the thread store), set once at create. An
  owned thread is an ordinary thread: it starts on a message and stops at cache expiry,
  its usage folds and counts, `thread read/send/get` take its id. `CreatedBy` (a thread
  id) did not fit and is refused together with an owner.
* **Hidden, everywhere at once.** Daemon: a filtered `ThreadService.List` (what `thread
  list`, `thread reports` and the CLI's resolvers use) leaves owned threads out unless
  `filter.owner` asks for them (`plugin:hello`, or `plugin:` for any plugin) or
  `filter.all` is set; the unfiltered List and the event streams still carry them (the
  GUI needs them to render the node). GUI: the threads store keeps them in `byId` but out
  of `order`, which the sidebar, `attentionIds` (bell, title, dock badge and bounce,
  cmd+shift+a, the start page), the Threads panel, lineage, pickers and option sources
  read; they sit in `owned`, which the Usage page adds to its totals. A plugin's flag on
  its own thread therefore never rings. Agents' `--all` lists them (with `(plugin:x)` on
  the line).
* **The thread's own env replaces its plugin's session environment.** `thread/create`'s
  `env` and `addDirs` are checked by the same `validateEnvironment` as
  `session/setEnvironment` (reserved keys, ≤ 8 KiB values, existing dirs under home), but
  any problem refuses the call (`-32602` naming each), since a create is explicit. They
  are stored on the thread (`spawn_env`, `spawn_add_dirs`) and appended on every spawn
  after the spawn extras (env wins; add-dirs after the plugins', before the
  attachments). `SpawnInfo.Owner` reaches `SessionEnvironment`, which skips the owning
  plugin's own contribution (no double apply); other plugins' still apply in scope.
* **cwd.** Default: the plugin's data dir (made if missing); with `projectId`, the
  project's main worktree, and a given `cwd` must then be one of its worktrees. A cwd
  without a project must be an existing directory under home (`CreateOptions.Cwd`, only
  with `NoProject`). Model and effort default to `threads.default_model` /
  `default_effort` (the daemon's adapter reads settings).
* **Reach only your own.** `thread/send` and `thread/archive` answer `-32004` for any
  thread the plugin does not own; a view whose thread or terminal node names another
  owner's thread or terminal is refused (an id the host does not know passes: the GUI
  shows it gone). Limits: 32 live (not archived) threads, 16 terminals per plugin.
* **Disable, uninstall, removal archive the threads and close the terminals** (`forget`,
  concurrently, 20 s bound), and `Start`'s sweep archives the live threads of plugins
  that are not enabled. A crash or restart keeps both; terminals end with the daemon like
  every shell (the GUI loses them on reconnect). A later `thread/send` unarchives.
  (Since `docs/notes/plugins-plugin-threads-remove.md`, uninstall and a forced takeover
  remove the threads instead; disable and a package gone by hand still archive.)
* **Terminals.** Labels `kind=plugin`, `plugin=<name>`, `title=<title>`. They are not
  panel terminals (`termlabel.IsPanel`): the shell reaper and `terminal.close` leave them
  alone, and an exited one stays until the plugin closes it. "Open in bottom panel" adds
  the terminal to the current selection's strip in this window (`TerminalsData.shownIn`)
  and focuses it; its tab's × only takes it off the strip.
* **Streams.** `startThreadWatch` counts holders per thread: the content pane and a
  thread node showing the same thread share one Watch; another thread gets its own. The
  log pruning (`KEPT_LOGS`) never drops a watched thread's log. A terminal node attaches
  its own `TerminalHost`; while the terminal is the active tab of the bottom panel on
  screen, the node says "Shown in the bottom panel." instead (two xterms would fight
  over the PTY's size).
* **Inline thread view.** `InlineThread` is the content pane's timeline and floating
  composer without the header, rows inset 12 px. Its composer ignores the content pane's
  focus requests, and leaving does not forget fold state. Heights: `auto` 420 px; `fill`
  measures the side panel's scroll root (`data-scroll-root`) below the node, at least
  240 px; a terminal's `auto` is its rows at the font size. Both node bodies are lazy
  chunks, so every surface does not import the thread view and xterm.
* **Act context.** `SurfaceActRequest.context` (the GUI sends its watch's panel context;
  `plugin act` its `--context-*`; a request with only `ref` uses the ref's) becomes
  `SurfaceAct.Context`. Capability `act.context`. The skill's "use a command button for
  thread-specific actions on shared instances" now says to read `act.Context`.
* **Capabilities** announced: `threads`, `terminals`, `view.node.thread`,
  `view.node.terminal`, `act.context`.
* `threads` and `terminals` joined the reserved plugin names (`plugin threads` /
  `plugin terminals` are verbs now).

## Deviations

* **`readOnly`, not `composer`.** The spec's `composer?: bool` is the existing
  `thread.readOnly` (PR 2's shape kept; `readOnly: true` is `composer: false`).
  `terminal.rows` stays as the `auto` height; `height` was added to both.
* **`thread list --plugin <name>`**, with `*` for every plugin's (Go's flag package has no
  optional values). The `plugin` arg is left out of the agent guide (its 29,000-byte
  budget; like the plugin namespace).
* **Env stored on the thread**, not in a plugin table: the first spawn happens inside
  `Create`, before the thread id is known to anyone else.
* **The Usage page counts plugin threads in its totals but does not group them under the
  plugin** (optional in the brief; skipped).
* The isolated end to end used `CODE_FOUNDRY_HOME=~/.cfp6`, not `/tmp`: a plugin's data
  dir must be under home to be a thread's cwd or add-dir, so a `/tmp` home cannot run
  the assistant (`addDirs … is outside your home directory`).

## Gotchas

* `TerminalHost` imports `keys/bindings` (and so the compose store): putting it in the
  node registry's static imports broke every test that mocks `@/api/threads` without
  `ATTACHMENT_MIME_TYPES`. The nodes load it lazily.
* The stores merge a reducer's result into their state: `owned` is always set (empty
  array) so a stale list never survives a merge.
* Resizing a terminal to fewer rows (the bottom panel after the node) drops the top lines
  of the screen, and growing it back reflows oddly: the hello demo's Restart gives a clean
  clock. Existing emulator behaviour, not new here.
* `make gui-e2e` ran with `E2E_MOCK_PORT=7866 E2E_VITE_PORT=9366`: PR 7's worktree held
  the default ports.
* Plugin threads start with the default permission mode (no setting picks another); a
  tool call that needs permission docks in the node's composer.
* Rebased onto main on 2026-10-18: main's `0028_thread_name_provisional.sql` and
  `Thread.name_provisional = 53` took the stack's numbers, so the owner migration is
  `0032` (`0031` is PR 7's installs) and `Thread.owner` is field 55 (`flags` is 54).

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=~/.cfp6`)

```
make build plugins
code-foundry daemon --dev &      # without the session's CLAUDE* vars
code-foundry settings set threads.default_model 'claude-haiku-5-5[1m]'
code-foundry settings set threads.default_effort low
code-foundry plugin dev plugins/examples/hello --yes --follow=false
code-foundry thread new --no-project --name "Ship plugin threads" --created-by=
T=s-f20aac336477
$ code-foundry plugin act hello demo tab --key assistant --context-thread $T
$ code-foundry plugin act hello demo tab --key shell --context-thread $T
$ code-foundry thread list
s-f20aac336477  idle  Ship plugin threads  no project  12s
$ code-foundry thread list --plugin hello
s-85cf5166e109  unknown  Hello assistant  no project  now  (plugin:hello)
$ code-foundry plugin terminals hello
ID              STATE    TITLE  PROGRAM  CWD
t-a358ef7dc8a0  running  Clock  sh       /Users/alex/.cfp6/plugin-data/hello
$ code-foundry plugin logs hello
host       thread created: s-85cf5166e109 "Hello assistant" in /Users/alex/.cfp6/plugin-data/hello (env CF_HELLO_THREAD; add-dirs 1)
host       terminal created: t-a358ef7dc8a0 "Clock" (sh) in /Users/alex/.cfp6/plugin-data/hello
$ code-foundry plugin act hello demo send-hello --context-thread $T
$ code-foundry thread read s-85cf5166e109
#1 you: say hello in one line
#3 tool Skill [done] {"skill":"hello-greeting"}          # the add-dir's SKILL.md
#4 claude: Hello from the hello plugin, running in its data directory.
#5 turn end: success, 3.5s, 49738 in / 150 out tokens, $0.0029, claude-haiku-5-5
```

The spawn's `--add-dir`s were the skills dir, `plugin-data/hello/assistant`, the
attachments dir; its environment had `CF_HELLO_THREAD=1` and not hello's session
`CF_HELLO`. `plugin act hello demo ask-main --context-thread $T` reached the plugin with
`act.Context.ThreadID = $T`, its `host/invoke thread.send` landed in the main thread
("Hi! The hello plugin's Assistant tab is working."). `plugin disable hello`: "archived its
threads: 1", "closed its terminals: 1"; `plugin threads hello` then shows it `[archived]`.

GUI: the frontend in WebKit (Playwright) against that daemon, as PR 5 did: the main
thread in the content pane, the Hello tab on Assistant (the inline thread with the real
exchange and its composer) and on Shell (the clock attached; then opened in the bottom
panel, the node saying so). Dark and light shots are on `cf/plugins-6-shots`. The test
thread transcripts and `~/.cfp6` were removed afterwards.

## Open

* Usage grouping by plugin; a plugin column in `plugin threads` cost.
* No per-thread "restart to pick up" when a plugin changes a thread's env (it is fixed at
  create).
* The pre-trust of a plugin thread's cwd writes to the real `~/.claude.json` like any
  thread's (an isolated daemon's entries stay there).
* A plugin terminal opened in a bottom panel is window-local and forgotten on reload.
