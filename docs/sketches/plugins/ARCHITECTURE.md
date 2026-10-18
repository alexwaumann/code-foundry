# Plugin system: architecture (daemon, protocol, GUI, lifecycle)

Status: design only, 2026-10-14. Companion to `BRIEF.md` (decisions) and `PRIMITIVES.md`
(the view model). Nothing here is built. Code blocks are illustrative sketches.

## 0. The recommendations in one table

| Question | Recommendation | Section |
|---|---|---|
| Where contributions are declared | In `plugin.json`, not the initialize reply (pushback 1) | A, B |
| Wire format | JSON-RPC 2.0, newline-delimited, over stdio (MCP's stdio shape) | B |
| Token model | **Proxied**: everything goes through stdio, no token by default; an `api` permission hands over the normal endpoint + token. No scoped tokens in v1 | B.5 |
| View model on the wire | JSON as `PRIMITIVES.md` defines it, validated generically by the daemon, carried to the GUI as `view_json`. Not proto | B.6 |
| Availability predicates | **Evaluated by the daemon**: a when-clause string over host facts plus keys the plugin pushes (`context/set`). Each surface gets a `plugin.<name>.show.<surface>` command, so the GUI's existing command-list sync carries availability | C.5 |
| Dynamic commands | `Registry.ReplacePrefix("plugin.<name>.", cmds)`. Commands come from the manifest and stay registered while the plugin is enabled | C.4 |
| Thread status | An overlay of **flags** on the session (`Session.flags`), never written into the stream-owned `status` | C.6 |
| Session env hook | **Push, not request**: the plugin pushes its contribution whenever its state changes, and `claudeCommand` reads it synchronously from the plugin snapshot. No RPC at spawn time. The only wait is a bounded 2 s grace while a declaring plugin is still starting | C.7 |
| Plugins management UI | A Plugins section in Settings. Plugin surfaces are side-panel tabs. A surface with `settings` placement also renders inline in that section | E.5 |
| PR order | 1 core + commands, 2 surfaces + predicates, 3 GUI renderer, 4 events + thread flags, 5 env hook. Each PR is shippable; Jenkins is accepted at PR 3/4, auth at PR 5 | G |

## Pushback on the brief

1. **Declare contributions in the manifest, not in `initialize`.** The host needs them
   before it spawns anything: for the consent dialog (what the plugin will do), for
   `plugin list` and the CLI help without running plugin code, for commands and surfaces
   that keep listing while the plugin is crashed or restarting, and for lazy activation
   later. `initialize` echoes the protocol and capabilities, and it may *narrow* what the
   manifest declares (drop a surface the backend lacks), never widen it.
2. **Token scoping is not a security boundary here.** A plugin runs as the user. It can
   read `~/.code-foundry/daemon.token` (0600, owned by the same user) and connect to the
   socket. Every Claude session already holds the full token (`sessionEnv`). Scoping
   protects against honest mistakes and makes intent auditable. It does not stop a
   malicious plugin. The real boundary is install and enable consent, and later
   `sandbox-exec` (§F). That is why the proxy-only default is enough and a scoped-token
   subsystem is not worth building yet.
3. **"From data it already has" is only half true for Jenkins.** The gh poll carries
   `CheckRollup` counts only. Check URLs (`CheckRun.url`) come only from the on-demand
   `GetPullRequest`/`ListChecks` (30 s cache). The predicate needs one async fact (C.5).
   That is another reason to evaluate on the daemon.
4. **No "files" contribution in the env hook.** The plugin runs as the user and can write
   its own files (into its data dir). The hook only points the session at them (env, MCP
   config). This avoids the daemon writing arbitrary paths for a plugin.

## A. The package on disk

```
~/.code-foundry/
  plugins/<name>/             the package; replaced as a whole on install/update
    plugin.json               manifest
    bin/jenkins               the executable (or any argv, see exec)
    assets/                   later: the iframe tier, served at /plugins/<name>/
  plugin-data/<name>/         the plugin's own state (0700), survives reinstall
    mcp.json                  written by the daemon from the env contribution (C.7)
  logs/plugins/<name>.log     stderr + log notifications, 1 MiB, one rotation
```

The data dir sits outside the package dir, so an update (an atomic rename of a new
package dir) never wipes credentials or caches. `plugin uninstall --purge` removes both.

### A.1 Manifest (`plugin.json`)

```json
{
  "name": "jenkins",
  "displayName": "Jenkins",
  "version": "0.3.0",
  "description": "Pipeline stages, logs and rebuilds for a PR's Jenkins checks.",
  "protocol": 1,
  "exec": ["bin/jenkins"],
  "permissions": {
    "commands": ["thread.send", "view.open.url", "pr.checks"],
    "events": ["session", "gh"],
    "threadStatus": true,
    "sessionEnv": false,
    "api": false
  },
  "commands": [
    { "name": "rebuild", "title": "Rebuild Jenkins Pipeline", "when": "jenkins.hasPipeline",
      "args": [{ "name": "id", "type": "string", "context": "session" }] },
    { "name": "abort", "title": "Abort Jenkins Build", "when": "jenkins.running",
      "confirm": "Abort the running Jenkins build of this thread's PR?",
      "args": [{ "name": "id", "type": "string", "context": "session" }] }
  ],
  "surfaces": [
    { "id": "pipeline", "title": "Jenkins", "icon": "workflow", "scope": "thread",
      "placement": ["panel"],
      "when": "thread.pr.check.url =~ /^https:\\/\\/jenkins\\.corp\\.example\\//" }
  ]
}
```

| Field | Rule |
|---|---|
| `name` | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (a command-name segment), equal to the directory name. Reserved: `list show install uninstall enable disable restart logs dev reload surface act` (they are `plugin.*` verbs) |
| `version` | semver; shown and used by the gh updater later |
| `protocol` | integer major. The host runs the plugin only if it supports that major (B.4) |
| `exec` | argv. `exec[0]` is relative to the package dir if it contains `/`, else it is resolved on the daemon's PATH (`node`, `python3`). cwd is the data dir |
| `permissions` | Shown at enable time and enforced on every stdio call (B.2). The daemon refuses `api` and `sessionEnv` unless they are granted |
| `commands[]` | Mapped 1:1 to `command.Command` (C.4) |
| `surfaces[]` | `scope`: `thread`, `project` or `global` (decides the instance key, C.3). `placement`: `panel` and/or `settings`. `icon`: a name from the GUI's allowlist (E.4). `when`: a predicate (C.5) |
| `sessionEnv` | `{ "description": "…" }` when the plugin contributes to sessions. Shown in consent and in Settings |

The manifest is parsed into a Go struct in the SDK package, the one schema for the daemon
and for authors. Unknown fields are kept and warned about, never rejected (forward
compatibility).

### A.2 Discovery, enablement, consent

* **Discovery.** The daemon scans `plugins/*/plugin.json` at start. An fsnotify watch on
  `plugins/` (debounced 300 ms) and `plugin.reload` trigger a rescan. A bad manifest
  still lists, as `failed` with the parse issue.
* **Enablement** lives in SQLite (migration after actions' 0020):
  `plugins(name PK, enabled, granted_json, granted_version, dev_path, installed_at,
  updated_at)`. A newly found plugin is *disabled* until `plugin.enable`. Its `Confirm`
  plus `DynamicConfirm` renders the permission list ("Jenkins may: send messages to
  threads, open URLs, read sessions and GitHub events, raise threads to needs-attention").
  So the GUI's existing confirm dialog is the consent UI, and the CLI gets `--yes` for
  free.
* **Updates.** An update that asks for more permissions than `granted_json` comes back
  disabled ("permissions changed"). An equal or smaller set stays enabled.

### A.3 Install and dev mode

| Story | v1 | Later |
|---|---|---|
| Install | `plugin install <dir>`: validate, copy into `plugins/.staging-<name>`, then atomic rename. Home-only paths (`fsx`) | `plugin install gh:owner/repo[@tag]`: the updater's path. `gh release download` of `<name>_<ver>_darwin_arm64.tar.gz` plus `checksums.txt`, sha256 check, unpack to staging, rename. Checked on the updater's 24 h tick. Bare executables, so MDM's bundle block does not apply (same as the app) |
| Dev | `plugin dev <dir>`: records `dev_path` (no copy), enables the plugin (consent once) and watches the dir. The manifest, `exec[0]` and, for script plugins, every file except `.git` and `node_modules` restart it (debounced 300 ms). The backoff is capped at 2 s and never gives up. Logs go at debug level. The row shows a `dev` chip | — |
| Uninstall | stop, remove the package dir and the DB row; `--purge` also removes `plugin-data/<name>` | — |

## B. The protocol

### B.1 Framing and handshake

* JSON-RPC 2.0 objects, one per line (NDJSON), UTF-8, on the plugin's stdin and stdout,
  exactly as MCP's stdio transport. No LSP `Content-Length` headers. **stdout carries the
  protocol only**: logs go to stderr or to `log` notifications. The Go SDK dups the real
  fd 1 for the protocol and points `os.Stdout` at stderr, so a stray `fmt.Println`
  cannot corrupt the stream.
* The max line is 4 MiB. A longer line is skipped (the same rule as
  `claudestream.Splitter`) and recorded as an issue.

```
host                                         plugin
 ── initialize {protocol:1, host:{version, capabilities[]},
               plugin:{name, dataDir, granted}, flags:[…its own live flags]} ──►
 ◄── result {protocol:1, capabilities[], narrow?:{surfaces:[ids to drop]}} ──
 ── initialized (notification) ──►            state: running
 … traffic …
 ── shutdown (request, 2 s) ──►  ◄── result
 close stdin; SIGTERM to the process group after 2 s; SIGKILL after 2 s more
```

### B.2 Methods

Host → plugin:

| Method | Kind | Params → result | Timeout |
|---|---|---|---|
| `initialize` | req | see above | 5 s, else `crashed` |
| `initialized` | notif | — | — |
| `command/invoke` | req | `{command, args:{k:v}, context:UiContext}` → `{message, json?, exitCode?}` | the manifest's `timeoutSeconds` (default 30, max 600) |
| `surface/open` | req | `{instance, surface, context, facts}` → `{}`; the plugin then sends `view/update`. `facts` carries what the predicate matched (e.g. the Jenkins check URLs) | 5 s ack; first view within 10 s or the GUI shows "not responding" |
| `surface/visibility` | notif | `{instance, visible}`: watchers went from 0 to more or back. The plugin may pause polling | — |
| `surface/close` | notif | `{instance}` after the grace (C.3) | — |
| `surface/act` | req | `{instance, version, action, key, value?, values:{key:value}}` → `{}` or an error (its message is toasted) | 10 s |
| `events/event` | notif | `{subscription, snapshot:bool, event}`: `event` is the protojson of `codefoundry.v1.Event`, the same JSON the TS client sees | — |
| `ping` | req | `{}` → `{}`, every 30 s | 5 s; two misses mean hung, so the host restarts it |
| `shutdown` | req | `{}` → `{}` | 2 s |

Plugin → host. Each method is checked against `permissions`: a missing permission is
error `-32001`.

| Method | Kind | Params | Permission |
|---|---|---|---|
| `view/update` | notif | `{instance, view}` (full replacement; the host numbers versions) | the surface is declared |
| `view/toast` | notif | `{instance?, level: info\|attention\|error, text}` | — |
| `context/set` | notif | `{key, value, sessionId? \| repoId?}`: predicate keys under `<name>.` (C.5) | — |
| `thread/setFlag` | req | `{sessionId, level: attention\|error\|none, reason, untilSeen}` | `threadStatus` |
| `host/invoke` | req | `{command, args, context, confirm: "never"\|"ask"}` → `{message, json}` | `commands` (globs) |
| `events/subscribe` | req | `{sources:[…]}` → `{subscription}`; `events/unsubscribe` | `events` |
| `session/setEnvironment` | req | the contribution (C.7) → `{applied, issues[]}` | `sessionEnv` |
| `log` | notif | `{level, msg, attrs}` | — |

`host/invoke` runs through `Registry.Invoke` with the plugin as caller (logged as
`caller=plugin:jenkins`). It never passes `Confirmed(true)`. A command with `Confirm`
returns the `ConfirmationRequired` error to the plugin, unless `confirm:"ask"` was set
and a GUI is connected. The daemon then emits a new `UiIntent.InvokeCommand{name, args,
context}` and the GUI runs it through `runCommand`, which shows the **daemon's own**
confirm text. The user confirms or not, and the plugin learns the outcome from events.
A plugin can never confirm on the user's behalf.

### B.3 Errors

The standard JSON-RPC codes, plus `-32001` permission denied, `-32002` unavailable (with
the command's WhyUnavailable), `-32003` confirmation required (`data: {message}`),
`-32004` not found, `-32005` rate limited. The Connect codes map onto these one-to-one in
`internal/api`, as `commandError` does.

### B.4 Versioning and capabilities

* **Protocol major** in the manifest and in `initialize`. The host supports N and N-1.
  A plugin whose major the host does not support is `failed` ("needs a newer
  Code Foundry").
* **Capabilities** are flat strings, both ways. Host: `surfaces`, `view.v1`,
  `view.node.<type>` for each primitive the GUI renders, `threadFlags`, `sessionEnv`,
  `events`, `invoke.ask`. Plugin: `surfaces`, `ping`. Additive changes are a new optional
  field or method plus a capability. Unknown fields are ignored by both sides. Unknown
  methods get `-32601`. A node type the GUI does not know renders nothing (plus an
  outline in dev mode), so a plugin can check `view.node.chips` before using it.

### B.5 Token model (recommendation: proxied)

| | Proxied over stdio (recommended) | Scoped daemon token | Full token |
|---|---|---|---|
| What the plugin gets | Nothing in env. It calls host methods | `CODE_FOUNDRY_TOKEN` scoped to procedures + commands | today's session env |
| Daemon work | Permission checks per method (a table) | A token table, a Connect interceptor per procedure, command allowlists in `CommandService.Invoke`, token rotation on restart | none |
| Attribution / rate limits | Natural: every call has a caller | Per token | none |
| Real security vs a same-user plugin | none (reads `daemon.token`) | none, same reason | none |
| Plugin ergonomics | Commands *are* the API; read data comes from events and command JSON results (`session.list --json`, `pr.checks`) | Full Connect clients | Full |

Recommendation: proxy everything. The `api` permission is the escape hatch: if granted,
the plugin's env gets `CODE_FOUNDRY_ENDPOINT` + `CODE_FOUNDRY_TOKEN` (the same pair every
session has), and the consent dialog says "full control of Code Foundry". A plugin
needing only a surface never sees the token. Scoped tokens become worth building only
together with `sandbox-exec` (§F), when a plugin can no longer read the token file.

Plugin process env: the daemon's env (already scrubbed of Claude and endpoint variables)
plus `CODE_FOUNDRY_PLUGIN=<name>`, `CODE_FOUNDRY_PLUGIN_DIR`, `CODE_FOUNDRY_PLUGIN_DATA`.
Never `CODE_FOUNDRY_SESSION` (the actions gotcha).

### B.6 The view model is JSON, not proto

`PRIMITIVES.md` uses a `type` discriminator (`{type:"button", key, action, …}`) and
polymorphic inline content (a string, a node or an array). protojson cannot express
either without reshaping the schema, and a proto copy would be a second schema to keep
in sync. So:

* The plugin sends the tree as plain JSON. The daemon **validates generically**, without
  knowing the primitives: at most 256 KiB, depth at most 32, at most 2000 nodes, `key`
  unique among siblings and required on every node with an `action` or a value, strings
  valid UTF-8. It collects the `action` ids of each version, so `Act` on an action not in
  the last two versions is rejected.
* The daemon forwards the tree byte-for-byte as `SurfaceView.view_json`.
  `src/api/plugin.ts` parses and narrows it into the TS view-model types (it is still
  the boundary). Adding a primitive is a GUI-only change plus a `view.node.<type>`
  capability.

### B.7 What to reuse from `internal/claudestream`

| Piece | Reuse? | How |
|---|---|---|
| `Process` (Setpgid, own pipes so a grandchild cannot hide the exit, stderr tail, group `Signal`, `CloseOutput`), `mergeEnv`, `lookPath` | **Yes** | Move into `internal/childproc` (Spec, Start returning stdin/stdout/stderr tail). `claudestream.Start` becomes a thin wrapper. The plugin actor and the actions' background runner use it too |
| `ReadLines` / `Splitter` (max-line framing) | Pattern only | The SDK is public (`pluginsdk/`) and cannot import `internal/`. Its JSON-RPC conn has its own ~60-line splitter, which the daemon uses through the SDK |
| `Conn` (request ids, waiting map, pump queue so the reader never blocks, replies on their own goroutine, pending calls failing on EOF) | Design, not code | The wire envelope differs (`control_request{request_id, request}` vs JSON-RPC). `Conn` is also specialized: typed `Event` parse, `PermissionRequest`, only inbound `can_use_tool`. New `pluginsdk/jsonrpc.Conn` (~300 lines) with the same structure, plus one thing `Conn` lacks: **an outbound queue goroutine**. `claudestream` writes synchronously under `wmu`; a plugin that stops reading stdin would block the daemon once the 64 KiB pipe fills. Here a full queue (4 MiB) means hung, and the plugin is restarted |

## C. Daemon

### C.1 Package layout (`internal/store/plugin`)

```
manifest.go     parse + validate plugin.json (SDK types), reserved names, predicate compile
discover.go     scan + fsnotify on plugins/ and dev paths
manager.go      Manager: actors by name, Snapshot, Enable/Disable/Restart/Install/Uninstall
actor.go        one goroutine per plugin: process, conn, state machine, backoff
surface.go      instances: open/close/grace, view versions, subscribers, coalescing
predicate.go    when-clause lexer/parser/evaluator (pure, table tests)
facts.go        host facts from snapshots; async PR-check fact with cache
env.go          session env contributions, conflict rules, mcp.json writer
flags.go        thread/setFlag forwarding into the session store's FlagSink
logs.go         stderr + log notifications to file and ring buffer
plugintest/     Fake (Store interface) for api/command tests
```

Dependencies the daemon injects, so the store imports no other store and nothing in
`internal/api`:

```go
type Options struct {
    Dir, DataDir, LogDir string
    DB        *sql.DB
    Bus       *bus.Bus
    Commands  CommandHost  // ReplacePrefix + Invoke (the *command.Registry satisfies it)
    Events    EventFeed    // Feed(ctx, sources) <-chan json.RawMessage; api.Events implements it
    Flags     FlagSink     // session.Store.SetFlag/ClearSource
    Facts     FactSource   // snapshots: sessions, repos; PullRequestChecks(ctx, url) (gh)
    Emitter   command.Emitter // InvokeCommand intents (confirm:"ask")
}
```

### C.2 Lifecycle

| State | Meaning | Leaves by |
|---|---|---|
| `disabled` | Found, not enabled (new, by the user, or permissions changed: `DisabledReason`) | `plugin.enable` → `starting` |
| `starting` | Spawned, initialize in flight (5 s) | reply → `running`; exit or timeout → `crashed` |
| `running` | initialized | exit, missed pings or full queue → `crashed`; disable → `stopping` |
| `crashed` | Waiting for the next attempt (`NextRestartAt`) | timer → `starting`; 5 crashes in 10 min → `failed` |
| `stopping` | shutdown → SIGTERM → SIGKILL (2 s each) | exit → `stopped` or `disabled` |
| `stopped` | Daemon shutting down, or `plugin.stop` | `plugin.restart` |
| `failed` | Bad manifest, unsupported protocol, exec missing, or gave up | `plugin.restart` (re-reads the manifest) |

* **Backoff** is 1, 2, 4, … up to 60 s, reset after 10 min running. Dev plugins cap at
  2 s and never reach `failed`.
* **Startup.** Every enabled plugin starts with the daemon, in parallel, after the
  stores and before the listeners. Lazy activation (`activation: "onSurface"`) is a later
  manifest field.
* **Shutdown.** Plugins stop before the session store closes, so a last `host/invoke`
  still has a registry behind it, and their flags are cleared in memory only (C.6).
* **Logs.** stderr lines and `log` notifications go to `logs/plugins/<name>.log` (1 MiB,
  one rotation) and to a 64 KiB in-memory tail for `plugin.logs` and the Settings row.
  `log` notifications are also echoed to slog with `plugin=<name>` at their level
  (rate-limited to 100/s). The last non-empty stderr line becomes `LastError` on a crash
  (`claudestream`'s `LastStderrLine`).

### C.3 Snapshot, bus events, surface instances

```go
type Snapshot struct{ Plugins []Plugin } // by name; atomic.Pointer like every store

type Plugin struct {
    Name, DisplayName, Version, Description string
    Dir      string; Dev bool
    Manifest Manifest          // declared contributions (narrowed by initialize)
    Enabled  bool; DisabledReason string
    State    State; PID int; StartedAt, NextRestartAt time.Time; Restarts int
    LastError string
    Issues   []Issue           // manifest warnings, env conflicts, rate limits, oversize views
    Granted  Permissions
    Protocol int; Capabilities []string
    Env      *EnvContribution  // the last pushed, redacted for the snapshot (keys only)
    Context  map[string]string // context/set keys (global); per-thread keys live in facts
}
```

Bus: `PluginChanged{Plugin}`, `PluginRemoved{Name}`, `AvailabilityChanged{Epoch}` (an
async fact resolved or a `context/set` arrived). Views do **not** go on the bus. They are
large and per instance, so each instance keeps its own subscriber list (the terminal
store's attach pattern: bounded channels, slow subscribers dropped and resynced with the
latest view).

**Instances.** The key is `<plugin>/<surface>/<scope id>`. The scope id is the session id
for `thread`, the repo id for `project`, `""` for `global`. The first `WatchSurface`
sends `surface/open`. The last watcher leaving starts a 60 s grace (`visibility:false`
at once, `surface/close` at the end), and the last view stays cached so reopening a tab
paints at once. Views are coalesced: latest wins, at most one every 100 ms per instance.
More than 50 updates/s sustained for 10 s → an issue, and the host drops the plugin to
1/s.

### C.4 Dynamic commands

The registry is populated once at startup today. The minimal change is one method:

```go
// ReplacePrefix atomically replaces every command whose name starts with prefix (which
// must end in ".") with cmds; each must carry the prefix and pass validate. Returns
// ErrDuplicate if a name outside the prefix collides.
func (r *Registry) ReplacePrefix(prefix string, cmds []Command) error
```

The plugin store calls it with `plugin.<name>.` on enable, on a manifest change and on
`initialize` (narrowing), and with an empty list on disable or uninstall. No change
callback is needed: every call is followed by a `PluginChanged`, and the GUI re-lists
commands on any plugin event (E.1). The CLI already builds verbs from `List` at run time.

| Manifest | `command.Command` |
|---|---|
| `name: "rebuild"` | `Name: "plugin.jenkins.rebuild"` (CLI `code-foundry plugin jenkins rebuild`) |
| `title`, `description` | `Title`, `Description` |
| — | `Category: displayName` |
| `args[]` `{name, type: string\|bool\|int\|enum\|path, required, enum, default, positional, context: session\|repo\|worktree\|terminal}` | `ArgSpec` (validated by the existing rules, reserved flags included) |
| `when` | `When`: compiled predicate ∧ plugin running. `WhyUnavailable`: "Jenkins is restarting (next try in 4 s)" or the predicate's |
| `confirm` | `Confirm` (placeholders validated). No `DynamicConfirm`/`ConfirmIf`: they would need a synchronous plugin call |
| `keybindings` | Ignored in v1 (collisions with built-ins). The user's `keybindings` setting overrides work by name already |
| — | `Run`: `command/invoke` with timeout → `Result{Message, JSON, ExitCode}` |

Per surface, the store also registers `plugin.<name>.show.<surface>`. Its `When` is the
surface predicate only (not running-ness, so a crashed plugin's tab still opens and
shows Restart). It emits `ShowView{name: "panel.plugin.<name>.<surface>"}`. The palette
gets "Show Jenkins" for free, and the GUI reads this command's `available` as the
surface's availability (C.5, E.2).

### C.5 Availability predicates (recommendation: evaluate on the daemon)

A when-clause string, VS Code style, compiled when the manifest loads (errors become
manifest issues):

```
expr := or ; or := and ("||" and)* ; and := unary ("&&" unary)*
unary := "!" unary | "(" expr ")" | fact [op value]
op := "==" | "!=" | "=~" | "in"      value := "str" | /re2/ | number | true | false | [ "a", "b" ]
```

A bare fact is truthy. For list facts, `==` and `=~` match if *any* element matches.

| Fact | Value | From | Cost |
|---|---|---|---|
| `view` | `thread`, `compose`, `projects`, `pullrequests` | UiContext | free |
| `thread` | a thread is active | UiContext | free |
| `thread.state`, `thread.status` | enums | session snapshot | free |
| `project`, `project.slug`, `project.git` | repo id, `owner/name`, bool | repo snapshot (the thread's owner project) | free |
| `workspace` | bool | UiContext | free |
| `thread.pr`, `thread.pr.url` | bool, urls | linked PRs, newest first, plus the branch PR | free |
| `thread.pr.check.url`, `thread.pr.check.name` | lists over the newest open PR's checks | `gh` `GetPullRequest` (30 s cache, paced queue) | **async** |
| `<plugin>.<key>` | what the plugin set with `context/set` (global, per thread, per project) | plugin push | free |

* **Async facts** evaluate to *unknown*, which lists as unavailable. Evaluating one
  schedules a fetch: deduplicated per PR, only for contexts someone listed (the GUI's
  selected thread), cached per `(url, head sha)` and invalidated by the gh poll's events.
  On resolve, `AvailabilityChanged` fires and the GUI re-lists. Cost: one cached GraphQL
  call per selected thread with a PR.
* **`context/set`** is the "ask the plugin" path without an RPC on the hot path. The
  Jenkins plugin, which subscribes to session and gh events, can set
  `jenkins.hasPipeline` for each thread itself, and its commands use that.

Why the daemon and not the frontend:

| | Daemon (recommended) | Frontend |
|---|---|---|
| Check URLs | gh store at hand | a new fetch per thread from a `warm` |
| Commands' `when` | the same evaluator | needs the daemon anyway (CLI, palette) |
| Implementations | one, Go, table tests | Go + TS |
| Plugin context keys | already there | would need a second channel |
| GUI change | none (rides `CommandService.List`) | an evaluator + fact store |

The cost of the daemon side is the async-fact re-list signal, which the plugin event
source provides anyway.

### C.6 Thread status: flags overlay

`status`/`status_reason` belong to the runner (busy/idle/needs-attention from the
stream; persisted error "interrupted"). Writing a plugin's attention into it would be
overwritten on the next busy→idle. It would also persist a plugin's reason after the
plugin is gone. Snooze writes it only because a snoozed thread has no stream. So:

```go
// session package; the session store knows nothing about plugins: Source is opaque.
type Flag struct {
    Source    string    // "plugin:jenkins"
    Level     FlagLevel // FlagAttention (amber), FlagError (red)
    Reason    string    // ≤ 80 runes, one line: "Jenkins: deploy stage failed"
    Since     time.Time
    UntilSeen bool      // cleared by the same acknowledge rule as a finished turn
}
// Store: SetFlag(ctx, sessionID, Flag), ClearFlag(ctx, sessionID, source), ClearSource(source)
```

* `Session.flags` is carried by `SessionEvent` (the session source, so the sidebar,
  dock and window title see it without a new stream). It is **not persisted**. After a
  daemon restart the plugin re-derives and re-raises its flags (Jenkins re-polls), so a
  removed plugin cannot leave stale flags.
* **Clearing.** The plugin clears its own (`level: none`). `UntilSeen` flags clear when
  the thread's `WatchItems` opens or while it is watched (the existing `acknowledge`
  points). `ClearSource` runs on disable and uninstall. A crash keeps the flags, and
  `initialize` hands the plugin its live flags so it can reconcile. Remove clears with
  the thread. Archived and snoozed threads keep their flags but never count
  (`attentionIds` already excludes them).
* **Limits.** One flag per (thread, plugin). Changes are limited to 1/s per thread.
* **GUI** (small edits, so not entirely "for free"): `isAttention` also counts
  attention-level flags, so the bell, badge, bounce, sound, `cmd+shift+a` and the
  attention+error sort group all follow. Error flags sort with errors and colour line 2
  red, but do not ring (as today's `error` does not). Line-2 reason precedence: stream
  attention reason > error flag > attention flag > the usual line. A busy thread with an
  attention flag leaves Working for the attention group.

### C.7 Session environment hook (recommendation: pushed contribution, synchronous read)

```json
{ "env":         { "ENTDATA_CREDENTIALS": "~/.code-foundry/plugin-data/entdata/creds.json" },
  "pathPrepend": ["~/.code-foundry/plugins/entdata/bin"],
  "addDirs":     [],
  "mcpServers":  { "entdata": { "type": "stdio", "command": "~/.code-foundry/plugins/entdata/bin/entdata-mcp", "args": [] } },
  "scope":       { "projects": ["b708d8f0629c"], "noProject": false } }
```

**Where it plugs in.** `claudeCommand(s, l, g)` is the one chokepoint for create,
reconnect, fork and the effort restart's `respawn`. Add one option, injected by the
daemon:

```go
// session.Options
SpawnExtras func(ctx context.Context, in SpawnInfo) SpawnExtras
type SpawnInfo  struct{ SessionID, RepoID, WorkspaceID string; MemberRepoIDs []string; Wait bool }
type SpawnExtras struct{ Env, PathPrepend, AddDirs, McpConfigs []string }
```

`claudeCommand` gains a ctx and appends: env through `mergeEnv`'s existing order (after
`opts.Env` and the workspace env), `--add-dir` for each dir after the workspace members,
and `--mcp-config <path>` for each config. `spawn` passes `Wait: true`. `respawn` passes
false: it runs on the runner goroutine and must never block. It re-reads the current
contribution, which is right for an effort restart (a fresh pointer or server list), the
same way it re-reads `st.grants`.

* **Push, not request.** The plugin calls `session/setEnvironment` whenever its state
  changes (signed in, signed out, projects picked). The store validates the
  contribution, writes `plugin-data/<name>/mcp.json` (0600; never in argv, which is
  logged and visible in `ps`), and keeps it in memory. `SpawnExtras` is then a map
  lookup: zero latency, no timeout, and a crashed plugin cannot wedge a spawn.
* **The only wait.** `Wait` blocks at most 2 s while a plugin that declares `sessionEnv`
  is still `starting` (daemon just started), until its first push or `initialized`. On
  expiry the spawn goes ahead without it and logs a warning.
* **While crashed**, the last contribution stays. On disable or uninstall it is dropped
  and `mcp.json` removed. Running sessions keep what they spawned with (env is fixed at
  exec). The GUI can later say "restart to pick up".
* **Credentials.** Point at secrets, do not inline them. A long-lived session outlives
  any token. The recommended auth pattern is a credentials file the plugin refreshes,
  or an MCP server command (the plugin's own binary in a `serve-mcp` mode) that reads it.

| Contribution | Allowed | Rule |
|---|---|---|
| `env` | yes | Reserved, refused with an issue: `CODE_FOUNDRY_*`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_EFFORT`, `PATH`, `HOME`, `SHELL`, `USER`, `TMPDIR`. Values ≤ 8 KiB; values never logged, only keys |
| `pathPrepend` | yes | absolute dirs under home, prepended to the daemon's PATH |
| `addDirs` | yes | existing dirs under home |
| `mcpServers` | yes | names `[A-Za-z0-9_-]{1,64}`; written to the plugin's `mcp.json`, passed with `--mcp-config` |
| `allowedTools` | **no in v1** | It is a permission escalation (auto-allowing `mcp__entdata__*`). If wanted later: its own permission, shown at consent |
| `--append-system-prompt` | **no** | It breaks the prompt cache's system snapshot, and Alex declined prompt lines for actions |
| files | **no** | The plugin writes its own (pushback 4) |

**Conflicts** are deterministic and visible. Plugins apply in name order. The same env
key or MCP server name from a later plugin is dropped, and the loser gets an issue
("ENTDATA_CREDENTIALS is also set by plugin x"). A plugin's MCP server named like one in
the user's own config: Claude's precedence applies. Verify which wins (open question 1).

**Scope** matches the thread's `repo_id`, or any workspace member's, or `noProject` for
home threads. Empty `projects` means all projects.

**Naming** (`ClaudeNamer`, `--safe-mode`) never gets contributions. Bottom-panel shells
do not either in v1 (open question 5).

### C.8 Event subscriptions

`events/subscribe {sources}` reuses the EventService multiplexer instead of re-encoding
store events. `api.Events` gets an exported `Feed(ctx, sources) <-chan json.RawMessage`
that runs Watch's loop (snapshot, live events, per-source resync on drop) with protojson
output. `Watch` is refactored onto it, and the daemon passes it as `plugin.Options.Events`.

* Plugins see the same shapes as the GUI's TS client (lowerCamel protojson).
* The `thread` source carries pending requests only, never items. A plugin needing
  items invokes `thread.items --json`.
* Allowed sources: repo, workspace, session, thread, gh, gitops, settings, update, action
  (once it lands), plugin. Not `ui` and not `terminal` (terminal output is not offered).
* Each plugin's event queue is bounded by bytes. On overflow the subscription drops and
  the source's snapshot is resent (`snapshot: true`), exactly the GUI's rule.

## D. API

### D.1 `proto/codefoundry/v1/plugin.proto` (sketch)

```proto
service PluginService {
  rpc List(ListPluginsRequest) returns (ListPluginsResponse) {}
  rpc Get(GetPluginRequest) returns (GetPluginResponse) {}
  rpc Enable(EnablePluginRequest) returns (EnablePluginResponse) {}    // echoes the granted permissions
  rpc Disable(DisablePluginRequest) returns (DisablePluginResponse) {}
  rpc Restart(RestartPluginRequest) returns (RestartPluginResponse) {}
  rpc Install(InstallPluginRequest) returns (InstallPluginResponse) {} // path (v1) | gh ref (later); dev
  rpc Uninstall(UninstallPluginRequest) returns (UninstallPluginResponse) {}
  rpc Logs(PluginLogsRequest) returns (PluginLogsResponse) {}          // tail + file path
  rpc Watch(WatchPluginsRequest) returns (stream PluginEvent) {}
  // The visible surface's stream: state, views, toasts, heartbeats.
  rpc WatchSurface(WatchSurfaceRequest) returns (stream SurfaceUpdate) {}
  rpc Act(SurfaceActRequest) returns (SurfaceActResponse) {}
}

message Plugin {
  string name = 1; string display_name = 2; string version = 3; string description = 4;
  PluginState state = 5; bool enabled = 6; string disabled_reason = 7; bool dev = 8;
  string last_error = 9; repeated PluginIssue issues = 10; repeated string permissions = 11;
  repeated PluginSurface surfaces = 12; google.protobuf.Timestamp next_restart_at = 13;
  repeated string env_keys = 14;  // what it injects, keys only
}
message PluginSurface {
  string kind = 1;                // "plugin.jenkins.pipeline": the GUI's SurfaceKind
  string id = 2; string title = 3; string icon = 4;
  SurfaceScope scope = 5; repeated SurfacePlacement placements = 6;
}
message WatchSurfaceRequest { string kind = 1; UiContext context = 2; }
message SurfaceUpdate {
  oneof update {
    SurfaceState state = 1;       // OPENING, LIVE, PLUGIN_DOWN (with plugin state), UNAVAILABLE
    SurfaceView view = 2;         // {instance, version, view_json}
    SurfaceToast toast = 3;
    StreamHeartbeat heartbeat = 4;
  }
}
message SurfaceActRequest {
  string instance = 1; uint64 version = 2; string action = 3; string key = 4;
  string value = 5; map<string, string> values = 6;
}
```

* **EventService.** Add `EVENT_SOURCE_PLUGIN` and `Event.plugin` (the numbers after the
  actions' 13/14). `PluginEvent {snapshot, updated, removed_name,
  availability_epoch}`, sent after `action`. `PluginService.Watch` stays for the CLI and
  tests, as for every service.
* **Session proto** gains `repeated SessionFlag flags` (`source`, `level`, `reason`,
  `since`). **UiIntent** gains `InvokeCommand{name, args, context}`.
* **WatchSurface** gets heartbeats (`api.HeartbeatInterval`) and joins the stream-liveness
  rules (`runStream`, `resyncOnVisible`).

### D.2 CLI verbs (all commands, so the GUI palette gets them too)

| Verb | Notes |
|---|---|
| `plugin list` | NAME, VERSION, STATE, PERMISSIONS, SURFACES, ISSUES |
| `plugin show <name>` | the manifest, state, env keys, issues, log path |
| `plugin install <dir>` | `--dev` = `plugin dev` |
| `plugin dev <dir>` | link + enable + watch |
| `plugin uninstall <name> [--purge]` | Confirm |
| `plugin enable <name>` / `plugin disable <name>` | enable's Confirm lists the permissions (consent) |
| `plugin restart <name>` | also leaves `failed` |
| `plugin logs <name> [--lines N]` | tail + path. `--follow` is not a command shape (Result is one-shot); `tail -f "$(code-foundry plugin logs jenkins --path)"` |
| `plugin reload` | rescan `plugins/` |
| `plugin surface <name> <surface> [--context-session id] [--wait-view]` | debug/e2e: opens an instance, prints the first view JSON and its action ids, closes. Agents can drive plugin surfaces with it |
| `plugin act <instance> <action> [--value v] [--values k=v,…]` | debug/e2e |
| `plugin <name> <verb> …` | the plugin's own commands (`plugin.<name>.<verb>`) |

## E. GUI

### E.1 Store and API boundary

* `src/api/plugin.ts`: maps `Plugin`/`PluginSurface` to view models, parses `view_json`
  into the `PRIMITIVES.md` TS types (narrowing unknown nodes to `{type: "unknown"}`).
  It is the only place that sees generated types.
* `stores/plugins.ts`: fed by the EventService `plugin` source. It holds plugins and
  their declared surfaces. Any plugin event schedules `refreshCommands()` (debounced
  like `startCommandSync`), which covers new commands and `AvailabilityChanged`.
* `stores/pluginSurfaces.ts`: the current view, version and state per instance, plus
  form drafts (E.3). Only the mounted surface writes it.

### E.2 Dynamic surface kinds

`surfaces/registry.ts` keeps its static array. One edit makes lookups fall through to
plugin specs:

```ts
// surfaces/plugin.ts
export function pluginSurfaceSpec(s: PluginSurfaceView): SurfaceSpec {
  const show = `plugin.${s.plugin}.show.${s.id}`;
  return {
    kind: s.kind, title: s.title, icon: pluginIcon(s.icon),        // allowlisted lucide icons
    available: (ctx) => pluginAvailability(s, show, ctx),          // reads plugins + commands stores
    watches: [usePluginsStore, useCommandsStore],
    render: (tab) => createElement(PluginSurface, { surface: s, tab }),
    openDefault: () => makeTab(s.kind, s.title),                   // no params: follows the selection, like MCP
  };
}
// registry.ts
export function surfaceOf(kind: SurfaceKind) { return byKind.get(kind) ?? pluginSpec(kind); }
export function allSurfaces() { return [...surfaces, ...pluginSpecs()]; } // the empty list
```

* **Availability.** The plugin is unknown or disabled → `hidden`. The show command is
  unavailable for this context → `hidden`. Otherwise `enabled`, even while the plugin is
  crashed (the body says so and offers Restart). The commands store must be listed for
  the panel's context (`contextKey` equal), else `hidden`. The visible panel is always
  the selection's, so this holds.
* **Tab ids** stay `kind[?params]` with kind `plugin.<name>.<surface>`. Persisted tabs
  survive restarts. A tab whose plugin is gone resolves to a placeholder spec ("Jenkins
  is not installed", Close), because `panel.ts` never prunes entries.
* **No hotkeys** for plugin surfaces (the letters are taken by built-ins). They open from
  the panel list, the palette's "Show Jenkins", and `ShowView panel.plugin.*`.

### E.3 Renderer (`components/plugin/`)

* `PluginSurface.tsx`: owns the stream. Mounted only as the active tab, it opens
  `WatchSurface(kind, uiContext of the panel's selection)` through `runStream` and aborts
  on unmount. **At most one WatchSurface at a time.** The settings inline surface counts,
  and the Settings page hides the side panel, so the budget holds: EventService, thread
  Watch, terminal Attach and WatchSurface. That is 4 of the six HTTP/1.1 connections,
  and Clone during Add Project makes 5 (open question 8).
* `PluginNode.tsx`: a `nodeRenderers: Record<NodeType, Component>` registry, not a
  switch. The primitives map onto existing pieces: the header onto `PaneHeader`/`shdr`,
  markdown onto `components/pr/Markdown.tsx`, pills and tags onto the existing small
  pills and tinted text, the log block onto the code-block Copy, and buttons onto
  shadcn `Button`. To add with shadcn: `input`, `select`, `checkbox`, `switch`,
  `progress`, `collapsible`. Links go through `view.open.url` (http/https only).
  `time` nodes tick on the client, so a plugin never pushes once a second for an elapsed
  clock.
* **Form state.** Inputs are keyed. The host keeps a draft per (instance, key) in
  `pluginSurfaces` (it survives tab switches, cleared on a successful submit). Rule: a
  view update changes a field only if the plugin's `value` differs from the last value
  it sent. A plugin that resets a field wins; an unchanged echo never clobbers typing.
  An action sends `values` for the inputs in its enclosing `form` node (else the whole
  surface). Secret values are redacted in daemon logs and never stored in drafts after
  submit. Validation is the plugin's: it returns the next view with `error` on the
  field.
* **Interaction states.** A clicked button shows `loading` until Act acks and the next
  view arrives (or the plugin sets `loading` itself). A node's `confirm` opens the
  existing confirm dialog before Act. Act errors and `SurfaceToast` become sonner
  toasts, rate-limited. Surface states: opening (skeleton after 300 ms), live, plugin
  down (amber or red notice with the state words + Restart), unavailable, and stale
  (last view dimmed while the stream reconnects).

### E.4 Icons

The manifest names lucide icons from an allowlist (`components/plugin/icons.ts`, ~40
names: workflow, key-round, shield-check, rocket, bug, database, …), because bundling all
of lucide defeats tree-shaking. An unknown name falls back to `Puzzle`.

### E.5 Where plugins are managed (recommendation: a Settings section)

Alex removed the Overview page, and a main-pane Plugins page would be one again. A
global "Plugins" panel surface is possible but crowds every panel's list with a rarely
used admin view. So:

* **Settings → Plugins** (custom section at the end of `SettingsPage`): one row per
  plugin with name, version, `dev` chip, state in words (amber `crashed`, red `failed`,
  neutral otherwise), what it injects (env keys, MCP server names), and always-visible
  muted actions: Enable/Disable (the consent confirm), Restart, Open log (in the editor,
  like the settings file). Plus "Install from folder…" (the native folder picker the Add
  Project dialog uses → `plugin.install`).
* A surface with `placement: ["settings"]` (the auth manager) renders **inline** under
  its row through the same renderer, at most one expanded at a time (one stream). With
  `["panel","settings"]` it is also a panel tab, available everywhere (`when` empty),
  under threads and the Projects page.

## F. Security and failure

| Risk | Handling |
|---|---|
| A malicious plugin | Out of reach by design (it runs as the user). The defenses: consent at enable listing the permissions, re-consent on a permission change, install only from a folder (v1) or a gh release with checksums (later; open question 10). Later: run plugins under a `sandbox-exec` profile that denies `daemon.token`, `daemon.sock` and `~/.claude*`. Only then do scoped tokens mean something |
| The token leaking to a surface-only plugin | No token in its env unless `api` is granted. Plugins never receive `CODE_FOUNDRY_SESSION` |
| A destructive plugin command | The manifest's `confirm` goes through the registry's Confirm (palette dialog, CLI `--yes`). A node's `confirm` uses the GUI dialog. `host/invoke` can never confirm on the user's behalf (`confirm:"ask"` shows the daemon's text) |
| A crash taking the daemon down | A separate process. Every host→plugin request has a timeout. The outbound queue is bounded, so a plugin that stops reading cannot block a daemon writer. A panic in the actor's protocol handling is recovered and counted as a crash |
| A wedged session start | Spawns read the env contribution from memory. The only wait is ≤ 2 s at daemon start, and `respawn` never waits |
| A hung plugin | `ping` every 30 s; two misses → restart. A full outbound queue → restart. A command timeout fails only that invoke |
| View floods and oversize views | Coalesce to ≤ 10/s per instance; sustained abuse → 1/s + issue. Over 256 KiB, depth or node caps → the update is rejected, the previous view stays, plus an issue (shown in dev mode as a notice in the surface) |
| Log floods | stderr ring buffer + 1 MiB file cap; `log` limited to 100/s; `toast` limited to 1/s |
| Flag spam | One flag per (thread, plugin), 1 change/s, reason ≤ 80 runes |
| Env clobbering | Reserved keys, name-order conflict rules with visible issues, values never logged, MCP config in a 0600 file, not argv |
| Path tricks | `exec[0]` must resolve inside the package dir or on PATH. `addDirs`, `pathPrepend` and install paths stay under home (`fsx`) |

## G. Build order

| PR | Contents | Acceptance (end to end) |
|---|---|---|
| **1. Daemon core + commands** | `internal/childproc` (moved out of `claudestream`); `pluginsdk` (manifest types, `jsonrpc.Conn`, `Serve` loop); `internal/store/plugin` (discovery, DB migration, actors, lifecycle, backoff, logs, ping); `Registry.ReplacePrefix`; `command/invoke`; `host/invoke` with allowlist; `PluginService` (minus surfaces); EventService `plugin` source; `plugin.*` verbs. Example `plugins/examples/hello` | CLI only: `plugin dev`, `plugin enable` (consent text), `plugin hello greet`, `plugin hello send --context-session s-…` (thread.send through the host), forced crash → backoff → `failed` → `restart`, `plugin logs` |
| **2. Surfaces + predicates (daemon)** | Instances, view validation and coalescing, `WatchSurface`/`Act`, `surface/*`, `view/*`, `context/set`; predicate compiler and evaluator (table tests), facts incl. async PR checks; `plugin.<n>.show.<s>` commands; a `pr.checks` read command (GhService.GetPullRequest; agents want it too); `UiIntent.InvokeCommand`; debug verbs `plugin surface` / `plugin act`. `plugins/examples/jenkins` v0 against `fakejenkins` (httptest: `wfapi/describe`, node logs, `/stop`, `/build`, crumbs) | `plugin surface jenkins pipeline --context-session …` prints the running, failed and needs-auth views; `plugin act … build.rebuild` hits the fake; availability flips when the PR's checks gain a Jenkins URL |
| **3. GUI renderer** | `api/plugin.ts`, `stores/plugins.ts` + `pluginSurfaces.ts`, `surfaces/plugin.ts` + registry fall-through, `components/plugin/*` (renderers, forms, icons), the Settings Plugins section, mock-daemon plugin fixtures, Playwright shots dark and light at 400 and 280 px | The Jenkins tab live on a thread whose PR has Jenkins checks: stages, log tail, Abort (confirm), Rebuild, Open in Jenkins, "Send failure to Claude" landing in the thread. Screenshots in the PR body |
| **4. Events + thread flags** | `api.Events.Feed`, `events/subscribe`; `Session.flags` (store, proto, acknowledge clearing); GUI `isAttention`, sort, line-2 reason, dock | Jenkins raises "Jenkins: deploy stage failed" on a background thread: sidebar group, bell, badge, bounce; opening the thread clears it (untilSeen); disabling the plugin clears it |
| **5. Session env hook** | `session.Options.SpawnExtras`, `claudeCommand` ctx, `--mcp-config` file, reserved keys, conflicts, scope, startup grace; `settings` placement inline; `plugins/examples/entdata` with a fake device-code IdP (RFC 8628) and a fake MCP server | Sign in via the wizard (open browser, copy code, choose environment) → a new thread in a scoped project shows the `entdata` server connected in the MCP tab and the env var in `printenv`; an effort restart keeps both; sign out → the next spawn has neither. **Run it once on the work laptop** (open question 1) |
| Later | gh release install + update checks; TS SDK; `activation: onSurface`; plugin-contributed actions in the header menu; `sandbox-exec`; the iframe tier at `/plugins/<name>/` | — |

PRs 4 and 5 depend only on PR 1 and can run in parallel with 2 and 3. PR 3 needs PR 2's
proto, and its HTML sketch already exists (`index.html`).

**Example plugins: Go, in `plugins/examples/<name>/` inside the main module.** They are
built by `make plugins` into `bin/plugins/` and compiled and tested by `make check`, but
are not in the release tarball. Go type-checks them against the SDK, and the fake
backends (`fakejenkins`, fake IdP) live beside them as httptest servers. Protocol tests in
`internal/store/plugin` use a re-executed test binary (the `fakeclaude_test.go` pattern),
and one ~30-line `python3` script plugin in `testdata/` proves the protocol is language
agnostic. Scripts as the *main* examples would leave the SDK untested.

**The minimal SDK** (`github.com/alexwaumann/code-foundry/pluginsdk`, stdlib only, in the
main module until versioning hurts):

```go
pluginsdk.Serve(pluginsdk.Plugin{
    Init:     func(ctx context.Context, h *pluginsdk.Host) error { … },  // subscribe, push env, set context
    Commands: map[string]pluginsdk.CommandFunc{"rebuild": rebuild},
    Surfaces: map[string]pluginsdk.SurfaceFactory{"pipeline": newPipeline}, // per instance: Open, Act, Close; h.Update(inst, view)
    OnEvent:  func(ctx context.Context, ev pluginsdk.Event) { … },
})
// Host: Invoke, SetFlag, SetContext, SetEnvironment, Subscribe, Toast, Log() *slog.Logger
// pluginsdk/ui: builders for the PRIMITIVES.md nodes; pluginsdk/plugintest: a fake host for unit tests
```

The TS SDK comes later: the same JSON types, shared with `src/api/plugin.ts`, plus an
NDJSON loop for node/bun.

## H. How plugins relate to Project actions

Actions (PRs #102/#104) are user-authored, per-project command lines stored in SQLite:
run in a terminal tab or in the background, with an `on_worktree_create` hook. Plugins
are installed code with a long-lived process, UI, and session contributions. **Keep
both. Neither subsumes the other.** Actions are the no-code tier. Wrapping each in a
plugin would be more ceremony for the commonest case.

They meet in three places:

1. **Shared plumbing.** `internal/childproc` serves the plugin actor and the actions'
   background runner (process group, tail buffer, kill rules).
2. **Plugins drive actions** through `host/invoke` of `action.*` (allowlisted). A setup
   plugin can create or run a project's actions instead of reinventing runners.
3. **Later**, plugin-contributed actions in the header play menu (`placement:
   "thread.header"`), and a `worktree.created` event as the plugin-side sibling of
   `on_worktree_create`.

## I. Open questions for Alex (ranked)

1. **Does `--mcp-config` survive the work laptop's managed settings?** It already
   refuses `--strict-mcp-config`. A `managed-mcp.json` or an MCP allowlist may block or
   filter added servers. If it does, the auth plugin's MCP entry must go through
   `claude mcp add --scope user` (the plugin runs as the user) and the hook shrinks to
   env only. This needs a 5-minute test on that machine before PR 5. Same test: which
   wins when a `--mcp-config` server shares a name with the user's.
2. **Manifest-declared contributions** instead of initialize-declared (pushback 1). OK?
3. **Consent.** New plugins disabled until enabled with the permission dialog, and
   re-consent on a permission superset. Enough, or also an allowlist of gh orgs for
   remote installs?
4. **Flag defaults.** `untilSeen` by default (clears when you look, like a finished
   turn) or sticky until the plugin clears it? Do attention flags ring the dock alert
   and sound like a prompt does? (Proposed: yes for attention, no for error.)
5. **Env hook for shells too?** A shell's interactive `claude` would also get the auth
   env. Proposed: sessions only in v1.
6. **`allowedTools` contribution.** Proposed: no in v1. Auto-allowing a plugin's MCP
   tools is convenient for non-technical users, but it is an escalation.
7. **Settings section for management + inline settings surfaces**, or a global
   "Plugins" panel surface?
8. **A fourth long-lived stream** (WatchSurface), or multiplex surface views over the
   EventService stream with a lease RPC? Proposed: a dedicated stream, which matches the
   one-stream-per-visible-thing rule and the heartbeat work. The cost is one of the six
   connections.
9. **Jenkins credentials.** The macOS Keychain via `security` (proposed) or a 0600 file
   in the plugin's data dir.
10. **Remote install source** (gh releases like the app, checksums only, no signing) and
    whether plugin updates follow the app's channel setting.
11. **Namespace.** `plugin.<name>.<verb>` with management verb names reserved (proposed),
    or management under `plugins.*` so no names need reserving.
