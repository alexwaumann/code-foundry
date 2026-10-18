# Plugins 1: daemon core, SDK, secrets, dynamic commands (2026-10-18)

The first PR of the plugin stack (`docs/sketches/plugins/DECISIONS.md`, build order row 1).
A plugin is a separate executable in `~/.code-foundry/plugins/<name>/` with a `plugin.json`;
the daemon runs each enabled one and speaks newline-delimited JSON-RPC 2.0 with it over
stdio. This PR has no GUI and no surfaces: plugins contribute commands, run host commands,
keep secrets and log. PRs 2+ build on `cf/plugins-1-core`.

## What is here

| Piece | Where |
|---|---|
| SDK, a nested module (`github.com/alexwaumann/code-foundry/pluginsdk`, stdlib only, `replace`d in `go.mod`) | `pluginsdk/`: manifest types + validation, JSON-RPC `Conn`, `Serve`, `Host`; `pluginsdk/ui` (view model); `pluginsdk/plugintest` (fake host) |
| Child process plumbing moved out of `claudestream` | `internal/childproc` (process group, owned pipes, stderr tail + per-line callback, env merge, PATH lookup); `claudestream.Start` wraps it |
| `Registry.ReplacePrefix` | `internal/command/registry.go` |
| Plugin store | `internal/store/plugin` (discovery, migration 0029, actors, host methods, logs, Keychain secrets); fakes in `plugin/plugintest` |
| `PluginService` + EventService `plugin` source | `proto/codefoundry/v1/plugin.proto`, `internal/api/plugin.go`, `plugin_events.go` |
| `plugin.*` verbs | `internal/command/commands_plugin.go`; CLI log following in `cmd/code-foundry/plugin.go` |
| Example plugin | `plugins/examples/hello` (main module), `make plugins` |
| Protocol proof without the SDK | `internal/store/plugin/testdata/pyecho` (34 lines of python3) |

## Decisions

* **Manifest = the registry's entry schema** (coordinator, 2026-10-18; the registry repo's
  README "Entry schema"): `permissions` has exactly `commands` (globs), `events` (sources),
  `threadStatus`, `sessionEnv`, `secrets` (gates `secret/*`), `threads`, `terminals`, `api`;
  missing keys read false/empty. `name` is `[a-z0-9][a-z0-9-]{0,63}`, `version` strict
  semver without a leading v. One extra rule: a plugin *with commands* needs a name that
  is also a command segment (letter first, no double or trailing hyphen), because its
  commands are `plugin.<name>.<command>` and the registry's `NamePattern` would refuse
  `plugin.1password.x`. Unknown fields are warnings (`Plugin.issues`), never errors.
  Reserved names: the `plugin.*` verbs (`list show install uninstall enable disable
  restart logs dev reload surface act secrets update`). Command names may be dotted
  (`run.rerun-failed`); `show.*` is reserved for PR 2's surface commands.
* **Consent**: a plugin found on disk is disabled. `PluginService.Enable` without
  `consent` returns `needs_consent` + `consent_text` and changes nothing; with it, the
  normalized permissions are stored (`plugins.granted_json`, `consented_at`). Re-enabling
  needs no consent while the manifest's permissions are within the grant
  (`Permissions.Within`: same globs as text, same sources, no new flag). A rescan or
  restart that finds more permissions disables the plugin with "its permissions changed".
  `plugin.enable` is a `Confirm` command whose `DynamicConfirm` is the consent text and
  whose `ConfirmIf` asks only when consent is needed, so the GUI's confirm dialog is the
  consent UI and the CLI gets `--yes`.
* **Lifecycle** as ARCHITECTURE §C.2: disabled → starting → running → crashed → … →
  failed; stopping/stopped. initialize within 5 s, `ping` every 30 s (5 s timeout, two
  misses restart it), a full outbound queue (4 MiB: it stopped reading stdin) restarts
  it, backoff 1, 2, 4 … 60 s, 5 crashes in 10 min → failed, 10 min running forgives.
  Dev plugins cap at 2 s and never fail for crashing. A start failure retrying cannot fix
  (unsupported protocol, a missing or non-executable `exec[0]`) fails at once (dev: keeps
  retrying, the author is about to build it). Stop: `shutdown` (2 s) → close stdin →
  SIGTERM to the process group → SIGKILL, 2 s each. The daemon starts plugins after every
  command is registered and stops them before the stores close.
* **Process**: `exec[0]` with a slash must resolve (symlinks too) to an executable inside
  the package dir; a bare name (`python3`) is looked up on PATH. **cwd is the package
  dir** and **the environment is minimal** (PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG,
  LC_*, TZ, SSH_AUTH_SOCK) plus `CODE_FOUNDRY_PLUGIN`, `CODE_FOUNDRY_PLUGIN_DIR`,
  `CODE_FOUNDRY_PLUGIN_DATA` (`~/.code-foundry/plugin-data/<name>`, 0700). With the `api`
  permission granted it also gets `CODE_FOUNDRY_ENDPOINT` + `CODE_FOUNDRY_TOKEN`. Never a
  thread id. (ARCHITECTURE §A.1/§B.5 said cwd = data dir and the daemon's whole env; the
  build brief chose the package dir and a minimal env.)
* **Commands**: a manifest command is `plugin.<name>.<command>`, category = display name,
  args mapped 1:1 (`context: thread|project|worktree|terminal`), `confirm` → `Confirm`.
  They are registered with `ReplacePrefix("plugin.<name>.", …)` on enable, rescan and
  restart, removed on disable; they stay while the plugin is down and then fail with
  `ErrUnavailable` + the reason ("crashed (…); next try in 3s", "failed (…); run
  `code-foundry plugin restart x`"). `when` is not evaluated yet (PR 2). Invoke sends
  `command/invoke {command, args (validated strings), context}` with the manifest's
  `timeoutSeconds` (default 30, max 600); the result's `json` becomes `--json` output.
* **Plugin → host** is a registry (`host.go` `hostMethods`), not a switch:
  `host/invoke` (the manifest's `permissions.commands` globs: `*` within a segment, `**`
  across; caller logged as `plugin:<name>`; never `Confirmed(true)`: a `Confirm` command
  answers `-32003` with `data.message`; `plugin.<reserved verb>` is refused whatever the
  globs, so a plugin cannot enable plugins or read other plugins' secrets), `log`, and
  `secret/get|set|delete|list` (permission `secrets`). The later methods (`view/*`,
  `context/set`, `thread/setFlag`, `events/*`, `session/setEnvironment`, `thread/*`,
  `terminal/*`) answer `-32601 "<method> is not supported yet by this Code Foundry"`; a
  later-step notification is logged once per run and ignored.
* **Secrets**: `KeychainService = code-foundry-plugin`, account `<plugin>/<key>`, through
  `/usr/bin/security`. The value never reaches argv: `Set` writes
  `add-generic-password -U -s … -a … -X <hex>` to `security -i` on stdin, `Get` parses
  `find-generic-password -g`'s stderr (`password: "…"` or `password: 0x<HEX> …` for
  non-printable values; `-w` prints hex or text ambiguously). Item not found is exit 44.
  `security` cannot list cheaply, so the names (never values) and set times live in
  `plugin_secrets`; `plugin secrets list` reads that. Keys `[A-Za-z0-9._-]{1,128}`,
  values non-empty UTF-8 ≤ 16 KiB. Logs carry keys only. Disabling keeps secrets.
* **Logs**: stderr lines, `log` notifications (`log <level> msg k=v`) and the daemon's own
  lines (`host`: start, pid, exit, refusals, host/invoke, secret keys) go to
  `logs/plugins/<name>.log` (1 MiB, one rotation to `.log.1`) and a 1000-line in-memory
  tail with sequence numbers. `log` notifications are echoed to the daemon log with
  `plugin=<name>` at their level, at most 100/s.
* **`plugin logs --follow` and `plugin dev`** stream `PluginService.FollowLogs` from the CLI
  after the command's result (a `cliFollower`, beside the existing `cliPresenters`), since a
  command's Result is one-shot. `plugin dev` follows by default only on a terminal (an
  agent's CLI never hangs unasked); `--follow=false` turns it off.
* **Agent guide** leaves the `plugin.*` namespace out (installed plugins would push it past
  the 29,000-byte limit) and points at `code-foundry plugin list` under Discover more.
* **SDK**: `Serve` points `os.Stdout` at stderr so a stray `fmt.Println` lands in the log
  (Go-level only, no fd dup: `syscall.Dup2` does not exist on linux/arm64). The JSON-RPC
  `Conn` has a reader, a bounded byte queue + writer (a peer that stops reading gets
  `ErrQueueFull`, never blocks a caller), ordered notifications on their own goroutine,
  requests each on their own goroutine with panics recovered, and the 4 MiB line cap
  (longer lines skipped to their newline, reported via `OnIssue`).
* **View model types** (`pluginsdk/ui`) follow the walkthrough's JSON (PRIMITIVES §D):
  lowerCamel field names, short enum strings, a plain `Inline` as a bare string, a node as
  `{key, <kind>: {…}}`. The 2026-10-18 additions: `View.tabs {items[{key,label,badge}],
  active}` (a view-level slot like the header, not a node), `thread {threadId, readOnly,
  placeholder}` and `terminal {terminalId, rows, title}` nodes, `fieldset` as a field
  control (`{label, hint, error, fields}`, no nesting), `select.optionsSource:
  projects|threads` (options must then be empty), a `duration {ms}` span beside `time`,
  `input.store` on secret inputs; plus the README's adopted `section.stale` and per-line
  log tone (`log.lines[{text, tone}]`, instead of `text`). There is **no `primary`
  button style** (DECISIONS: no filled buttons); `Validate` refuses it. `Validate` checks
  the PRIMITIVES §B limits (400 elements, depth 3, 256 KB without logs, string caps,
  button caps, 4 logs, key shape and one key namespace, http(s) URLs, secrets never
  carrying a value and only submitted through an event).

## Gotchas

* `go vet ./...` and `go test ./...` from the root do not reach the nested `pluginsdk`
  module; the Makefile runs them (and staticcheck, via `go tool -n staticcheck`) from
  `pluginsdk/`. The examples live in the main module so `./...` builds and tests them.
* The store tests re-execute the test binary as the plugin: `bin/plugin` in a temp package
  is a two-line script `CF_PLUGIN_HELPER=<mode> exec <test binary>` and an `init()` in
  `helper_test.go` serves that mode. Scripts are needed because the plugin env is minimal.
* `pgrep -f "code-foundry daemon --dev"` also matches the shell that started it; kill the
  pid `code-foundry daemon status` prints.
* `TestKeychainRoundTrip` uses the real login Keychain only with `CF_TEST_KEYCHAIN=1`.

## Try it

```
make build plugins
export CODE_FOUNDRY_HOME=/tmp/cfp1            # an isolated daemon
./bin/code-foundry daemon --dev &
./bin/code-foundry plugin dev plugins/examples/hello        # prints the consent text; --yes consents
./bin/code-foundry plugin list
./bin/code-foundry plugin hello greet Ada
./bin/code-foundry plugin hello send "hi" --context-thread <thread id>
./bin/code-foundry plugin hello remember swordfish && ./bin/code-foundry plugin hello recall
./bin/code-foundry plugin logs hello --follow
```

## End to end (2026-10-18, isolated `CODE_FOUNDRY_HOME=/tmp/cfp1`)

```
$ code-foundry plugin dev plugins/examples/hello          # no terminal: asks for --yes
code-foundry plugin.dev: Enable Hello 0.1.0? It runs bin/hello as you and may:
  - run Code Foundry commands: thread.send
  - keep secrets in your Keychain (its own, under code-foundry-plugin)
Re-run with --yes to confirm.
$ code-foundry plugin dev plugins/examples/hello --yes
linked …/plugins/examples/hello as dev plugin hello; enabled hello 0.1.0 (starting)
commands: code-foundry plugin hello greet, code-foundry plugin hello send, …
$ code-foundry plugin list
NAME   VERSION  STATE          PERMISSIONS                    COMMANDS  NOTE
hello  0.1.0    running (dev)  commands(thread.send) secrets  5
$ code-foundry plugin hello greet Ada          # and --json: {"greeting":"Hello, Ada!"}
Hello, Ada!
$ code-foundry plugin hello send hi --context-thread t-nope   # through host/invoke
code-foundry: plugin.hello.send: thread.send: not_found: no thread id ends in "t-nope" (unknown)
$ code-foundry plugin hello remember swordfish && code-foundry plugin hello recall && code-foundry plugin secrets list hello
remembered (in the Keychain)
the word is swordfish
KEY   SET
word  2026-10-18 05:23
$ kill -9 <pid from plugin list --json>; code-foundry plugin list; code-foundry plugin hello greet
hello  0.1.0    crashed (dev)  …  was killed by a signal (restart 1)
code-foundry plugin.hello.greet: not available in this context: plugin hello crashed (was killed by a signal); next try in 1s
$ code-foundry plugin list        # a second later: a new pid, Restarts 1
hello  0.1.0    running (dev)  commands(thread.send) secrets  5
$ code-foundry plugin logs hello --lines 30
05:23:04.778 host       starting hello 0.1.0 (pid 66730)
05:23:04.870 host       running
05:23:04.870 log info   hello is up data_dir=/tmp/cfp1/plugin-data/hello dev=true host=dev
05:23:05.860 host       host/invoke thread.send
05:23:05.906 host       secret set: word
05:23:11.226 host       was killed by a signal
05:23:11.226 host       restarting in 1s
05:23:12.228 host       starting hello 0.1.0 (pid 66763)
05:23:12.230 host       running
log file: /tmp/cfp1/logs/plugins/hello.log
$ code-foundry plugin disable hello; code-foundry plugin hello greet
code-foundry: unknown command "plugin hello greet" …
$ code-foundry plugin enable hello            # consent remembered: no prompt
enabled hello 0.1.0 (starting)
$ code-foundry plugin logs hello --lines 2 --follow   # then Ctrl-C
following the log of plugin hello (Ctrl-C to stop)
05:23:20.893 host       secret deleted by the user: word
05:23:21.957 log debug  greeting name=follow
05:23:25.983 log debug  greeting name=follower
$ code-foundry events --source plugin          # while disabling another plugin
- plugin snapshot
1 plugin updated crasher
```

A non-dev plugin whose `bin/crash` prints `crasher: cannot read config` and exits 1:
backoff 1, 2, 4, 8 s, then

```
crasher  0.0.1    failed  -  1  crashed 5 times in 10m, last: exited with status 1: crasher: cannot read config
$ code-foundry plugin crasher noop
… plugin crasher failed (…); run `code-foundry plugin restart crasher`
$ # point bin/crash at the hello binary, then
$ code-foundry plugin restart crasher && code-foundry plugin list
crasher  0.0.1    running  -  1
```

SIGTERM to the daemon: the plugin logs `hello is stopping`, the host logs `stopped`, and
the process is gone. Enabled plugins start again with the next daemon.

## Open for PR 2+

* Surfaces: instances, the daemon's generic view validation (the SDK's `ui.Validate` is
  the typed half), `surface/*` / `view/*`, `context/set`, predicates for `when` (commands
  are always available now), `plugin.<n>.show.<s>`. Reconcile method names: the SDK uses
  ARCHITECTURE §B.2 (`view/update`, `surface/act`); PRIMITIVES §C says `surface/render`,
  `surface/append`, `surface/event`. `SurfaceAct` carries `kind`
  (click/submit/change/tab) and `values map[string]any`.
* `host/invoke` with `confirm: "ask"` → `UiIntent.InvokeCommand` (today: `-32003`).
* `events/subscribe` (+ `events/event`), `thread/setFlag`, `session/setEnvironment` through
  the spawn-extras slot (PR 3); `thread/create|send`, `terminal/create|close` (PR 6).
* No fsnotify yet: `plugins/` changes need `plugin reload`, a dev plugin's rebuilt binary
  `plugin restart` (ARCHITECTURE §A.2/§A.3 watch both, debounced 300 ms).
* `plugin install|uninstall [--purge]` (purge deletes secrets) and the registry (PR 7).
* GUI (PR 5): `Event.plugin` is generated in TS but no store consumes it; the mock daemon
  has no plugin fixture; the Settings → Plugins page and consent dialog (plugin.enable's
  confirm already carries the text).
* `initialize`'s `narrow` is ignored (no surfaces yet); host capabilities announced:
  `invoke`, `secrets`, `log`.
* A command of a down plugin fails as FailedPrecondition, which the CLI treats like a
  usage error (exit 2 plus a help pointer); fine for now, maybe its own code later.
