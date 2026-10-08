# Phase 1d: Command registry, CommandService, UiService, CLI verbs

Status: done on branch. `make check` is green. Exercised end to end with the built binary
on a temp `CODE_FOUNDRY_HOME`: `commands`, the registry path (`daemon.status`, `daemon status`,
`--json`), `ui notify` with no watcher (`delivered=0`) and with a Go client holding
`WatchIntents` open (`delivered=1`, the intent arrived), plus clean errors and exit codes for an
unknown command, a missing required arg, a bad enum, and an unavailable command.
`cmd/code-foundry/e2e_test.go` automates the same checks against an in-process daemon.

## Layout added

| Path | What |
|---|---|
| `internal/command/command.go` | `Command`, `Context`, `ContextField`, `Result`, name rules, sentinel errors |
| `internal/command/args.go` | `ArgType`, `ArgSpec`, `Args` (typed accessors), `ArgError`, `ExpandPath`, `SplitWords` |
| `internal/command/registry.go` | `Registry`: `Register`, `RegisterAll`, `List`, `Get`, `Invoke` |
| `internal/command/intent.go` | `IntentEvent` (bus event), `Emitter`, `BusEmitter`, `Result.EncodeJSON` |
| `internal/command/commands_daemon.go` | `daemon.status`, `daemon.version` |
| `internal/command/commands_ui.go` | `ui.palette.open`, `ui.notify`, `ui.focus.terminal`, `ui.focus.repo` |
| `internal/command/commands_terminal.go` | `TerminalBackend` + `terminal.new`, `terminal.kill`, `terminal.remove` |
| `internal/command/commands_repo.go` | `RepoBackend` + `repo.register`, `repo.unregister`, `repo.worktree.new`, `repo.worktree.remove`, `repo.refresh` |
| `internal/command/all` | `all.Register(reg, all.Deps{...})`, the one wiring call |
| `internal/command/commandtest` | fakes: `Emitter`, `Terminal`, `Repo` |
| `internal/api/command.go`, `ui.go` | thin `CommandService` / `UiService` handlers |
| `internal/client/command.go` | `ListCommands`, `InvokeCommand`, `WatchIntents` helpers (+ `Command`, `UI` clients on `Client`) |
| `cmd/code-foundry/registry.go` | generated verbs, `commands`, `help <name>` |

## Decisions

* **Explicit registration, no `init()`.** Each domain file exports `Register<Domain>(reg, deps)`.
  The daemon calls `all.Register` once, so the full command set and its dependencies sit at a
  single call site, tests can build registries with fakes, and import order has no side effects.
  `RegisterAll` joins errors. A duplicate name or a malformed command fails daemon startup.
* **Store-backed commands depend on Connect-shaped interfaces.** `TerminalBackend` and
  `RepoBackend` are subsets of the generated `TerminalServiceHandler` / `RepoServiceHandler`
  method sets. Compile-time assertions check that both the generated handler and client
  interfaces satisfy them. The proto contracts are the only API fixed across the parallel
  branches; the store packages' Go APIs aren't. With these interfaces, the 1a/1b API handlers
  plug in with no adapter, the commands reuse the handlers' validation and error codes, and
  `UnimplementedTerminalServiceHandler{}` / `UnimplementedRepoServiceHandler{}` stand in until
  merge. `all.Register` uses those stubs when `Deps.Terminal`/`Deps.Repo` is nil. So
  `terminal.*` and `repo.*` show up in `List` today (the GUI step can build against them) and
  fail with `Unimplemented` when invoked.
* **Context-bound args (`ArgSpec.Context`).** An arg can default from a `UiContext` field
  (`terminal.kill --id` defaults to the active terminal). It also works in reverse: an
  explicit value stands in for that field when `When` is evaluated on Invoke, so
  `code-foundry terminal kill --id t1` works without `--context-terminal`, and
  `repo.worktree.new --repo r1` works without an active repo. `When` stays a pure
  `func(Context) bool`. `Run` receives the overlaid context.
* **Invoke check order**: unknown name (NotFound) → arg syntax: unknown arg, bad int/bool/enum,
  relative path (InvalidArgument) → `When` (FailedPrecondition) → required args
  (InvalidArgument) → `Run`. Empty-string values count as absent, so the palette can send
  blank fields.
* **Error mapping** (`api.commandError`): `ErrUnknownCommand`→NotFound,
  `ErrInvalidArgs`→InvalidArgument, `ErrUnavailable`→FailedPrecondition. A `*connect.Error`
  from a backend keeps its code. Context cancel/deadline map to Canceled/DeadlineExceeded, and
  anything else maps to Unknown. `Run` funcs that detect bad input themselves return
  `command.InvalidArg(...)`.
* **Paths**: the daemon's cwd is `/`, so `Path` args must be absolute after `~` expansion
  (`~user` is rejected). The CLI makes relative `Path` flags and `--context-worktree`
  absolute against its own cwd before sending, and passes `~` through for the daemon to expand.
* **`Result.JSON`** is encoded with protojson for proto messages (lowerCamel, same as the TS
  client sees) and with encoding/json otherwise. It is empty when nil.
* **No proto changes.** `make gen` regenerates `gui/frontend/src/gen`, which this step must not
  touch, and nothing required a change. On the wire, an arg with a context default is sent as
  `required=false`, with "(default: the active terminal)" appended to its description. The
  daemon still enforces it as required when the context is empty.
* **UiService**: intents travel on the bus as `command.IntentEvent`. Each `WatchIntents` stream
  is one bus subscription with a 32-intent buffer. Slow watchers miss intents (bus drop
  semantics) and never block emitters. `Emit` and the `ui.*` commands share `BusEmitter`, so
  `delivered` is the number of watchers whose buffer accepted the intent. `WatchIntents`
  flushes response headers right after subscribing. `client.WatchIntents` blocks on
  `ResponseHeader()`, so once it returns, the watcher is guaranteed to be counted (no sleeps
  in tests). `Emit` rejects an intent with no oneof case set (InvalidArgument).
* **`terminal.new` defaults**: argv is the user's `$SHELL -l` (fallback `/bin/zsh -l`). cwd is
  the active worktree, else `$HOME`. `--argv` is split shell-style (quotes and backslashes, no
  expansion) by `command.SplitWords`.
* **Keybindings declared**: `ui.palette.open` = `cmd+k`, `terminal.new` = `cmd+t`. The GUI may
  handle `ui.*` locally instead of round-tripping through the daemon. These are only defaults
  for the keybinding map.

## CLI

* `code-foundry <name> [flags]`, where name is dotted (`terminal.new`) or space-separated
  (`terminal new`, `repo worktree new`). The CLI resolves the longest word prefix that names a
  command in `CommandService.List(include_unavailable)`. New commands therefore need no CLI
  edit.
* Flags come from the ArgSpecs. Bool args are bare (`--force`). Unset flags are omitted so the
  daemon applies defaults. Every verb also has `--json` (prints `result_json`, or `null`),
  `--context-terminal`, `--context-session`, `--context-repo`, and `--context-worktree`.
  `-h` prints the command's help.
* `code-foundry commands [--context-*]` prints CATEGORY / NAME / AVAILABLE / TITLE for every
  command. `code-foundry help <name…>` prints one command's help. `code-foundry help` alone
  stays local and never starts the daemon.
* Local verbs (`daemon`, `status`, `version`, `commands`, `help`) win, except when a local verb
  is followed by a bare word: `daemon status` is the registry command `daemon.status`, not
  `daemon` with an argument. Dotted names can never collide with local verbs.
* Exit codes: 0 on success. 2 for caller mistakes: unknown command, bad flags, InvalidArgument,
  FailedPrecondition. These print `code-foundry <name>: <message>` plus a `help` pointer.
  1 for everything else, e.g. `Unimplemented` from a stub backend.
* `cli` struct: I/O, `connect`, and `getwd` are injected, so unit tests never auto-start a
  daemon and `e2e_test.go` runs the real dispatcher against an in-process daemon.

## Naming conventions

* Command names: `^[a-z]+(\.[a-z][a-z0-9]*)+$`. Domain first, then object, then verb:
  `terminal.new`, `repo.worktree.remove`, `ui.focus.terminal`. Stable once shipped, because
  they are the CLI verbs and keybinding targets.
* Arg names: kebab-case (`delete-branch`), because they are CLI flags verbatim. Reserved:
  `json`, `help`, `h`, `context-*`.
* Titles are palette text in Title Case ("New Worktree"). Categories are palette groups
  ("Terminal", "Repository", "View", "Daemon").
* Messages are short lowercase status lines ("created terminal t1"). Structured data goes in
  `Result.JSON`.

## How to add a command

1. Pick the domain file (`internal/command/commands_<domain>.go`), or add one for a new domain.
2. Append a `Command{...}` to that domain's `Register<Domain>` `RegisterAll` call. Declare args
   with types. Use `Context:` for args that should default from what the user is looking at,
   and `When` for availability.
3. A new domain with a new dependency adds a field to `all.Deps` and one line to
   `all.Register`. If the dependency is a service from another step, express it as a subset
   of that service's generated Connect handler interface (see `TerminalBackend`).
4. Add rows to the table tests in `commands_test.go` (args → backend request or intent,
   availability).
5. Nothing else. The palette, CLI verb, help, and `commands` listing all come from the
   registry.

## Merge wiring for store-backed commands

On this branch, `internal/daemon/daemon.go` builds the bus and registry and calls
`all.Register` with `Terminal`/`Repo` left nil (so the Unimplemented stubs are used):

```go
events := bus.New()
commands := command.NewRegistry()
if err := all.Register(commands, all.Deps{
    Daemon:  command.DaemonInfo{PID: os.Getpid(), Version: opts.Version, Started: started, Home: p.Home(), Socket: p.Socket()},
    Emitter: command.BusEmitter{Bus: events},
    // Terminal: <TerminalService handler from 1a>,
    // Repo:     <RepoService handler from 1b>,
}); err != nil { ... }
routes := []api.Route{ ..., api.NewCommand(commands).Route(), api.NewUI(events).Route() }
```

When 1a/1b land, construct their handler once, mount its route, and pass the same value in
`Deps`:

```go
terminalAPI := api.NewTerminal(terminalStore /* whatever 1a's constructor takes */)
repoAPI := api.NewRepo(repoStore)
... all.Deps{ ..., Terminal: terminalAPI, Repo: repoAPI }
routes := []api.Route{ ..., terminalAPI.Route(), repoAPI.Route(), ... }
```

Anything implementing `codefoundryv1connect.TerminalServiceHandler` /
`RepoServiceHandler` compiles as-is. If 1a or 1b also create a `bus.New()` in `daemon.go`, keep
a single bus and pass it to everyone: `UiService` and the `ui.*` commands must share it. No
other file changes are needed for the merge.

## Gotchas

* **Long-lived streams vs. shutdown.** `http.Server.Shutdown` does not cancel request
  contexts. An open `WatchIntents` (or any server stream) therefore holds shutdown until the
  5s `shutdownTimeout` cuts it. This follows from net/http semantics and wasn't measured
  here. A follow-up should set `BaseContext` on the daemon's servers to a context that is
  cancelled when shutdown starts. That would be a small change in `newServer`, deliberately not
  made in this step to keep `daemon.go` edits to the route lines.
* `go build ./...` needs `gui/frontend/dist` (`make gui-dist-stub` creates a placeholder).
  Use `go build ./cmd/... ./internal/...` for quick loops.
