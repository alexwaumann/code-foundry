# code-foundry — Architecture

A macOS desktop app for running and supervising fleets of Claude Code sessions
across many git repositories and worktrees. Every user has `git`, `gh` (authenticated),
and `claude` (authenticated) installed on a recent MacBook Pro running current macOS.

This document is the source of truth for structure and boundaries. Feature-level
docs live next to the code they describe. The build-out plan is in `PLAN.md`.

## 1. Shape

Three processes, one protocol.

```
┌──────────────────────────┐     Connect (protobuf) over loopback HTTP + bearer token
│  GUI  (Wails v3 window)  │◄──────────────────────────────────────────────┐
│  React + xterm.js        │                                               │
└──────────────────────────┘                                               │
                                                                           ▼
┌──────────────────────────┐     Connect (protobuf) over Unix socket  ┌──────────────────┐
│  CLI  (code-foundry …)   │◄───────────────────────────────────────►│      DAEMON       │
└──────────────────────────┘                                         │  owns everything  │
                                                                      │  that is not      │
                                                                      │  pixels           │
                                                                      └──────────────────┘
```

* **Daemon** (`code-foundry daemon`) owns PTYs, terminal emulation (libghostty-vt),
  Claude session lifecycle and status detection, git and GitHub workers, SQLite, and the
  command registry. It never renders. It outlives the window: closing or crashing the GUI
  does not kill sessions.
* **GUI** is a Wails v3 shell hosting a React frontend. The frontend talks to the daemon
  *directly* with Connect-Web over a loopback HTTP listener. The Go host process in Wails is
  deliberately thin: window, menu, native dialogs, and injecting the daemon's address and
  token into the page. No business logic lives in the Wails host.
* **CLI** subcommands (`code-foundry new-session --repo foo`, `code-foundry focus <id>`, …)
  are clients of the same daemon API. A Claude Code session running inside the app can call
  the CLI, so sessions can orchestrate other sessions.

One binary. `code-foundry` with no args launches the GUI. `code-foundry daemon` runs the
daemon in the foreground. Every client auto-starts the daemon if the socket is absent.

## 2. The one rule

**Stores own processes and publish snapshots. Views read snapshots and emit intents.**

The daemon's stores are goroutine-owned actors. Each publishes an immutable snapshot
(`atomic.Pointer[Snapshot]`) and emits typed change events on an internal bus. API
handlers are thin: they read snapshots, subscribe to events, and forward intents to
stores. Nothing in the daemon imports the GUI, and nothing in the GUI reaches a store
except through the protocol.

## 3. Repository layout

```
cmd/code-foundry/          main package: subcommand dispatch (daemon, gui, cli verbs)
proto/codefoundry/v1/      *.proto — the API. buf-managed. Generated code is committed.
gen/go/                    generated Go (connect-go + protobuf-go)
gui/frontend/src/gen/      generated TS (protobuf-es + connect-es)
internal/
  daemon/                  bootstrap, listeners (UDS + loopback), token file, lifecycle
  api/                     Connect service handlers. Thin. One file per service.
  bus/                     typed in-process event bus (generic pub/sub, bounded, non-blocking)
  command/                 command registry: name, arg schema, when-predicate, handler
  store/
    terminal/              PTY + libghostty-vt actor per terminal; output tee; snapshots
    session/               Claude sessions layered on terminal: spawn, naming, status, resume
    repo/                  registered repos, worktrees, git status, filesystem watcher
    gh/                    gh GraphQL polling, PR/CI cache
    gitops/                git/gh operations per worktree (fetch, pull, push, PR); editor, Finder, browser
  db/                      SQLite (modernc.org/sqlite, WAL) + migrations
  client/                  Go client for the daemon API, used by CLI and the Wails host
  paths/                   XDG-ish paths: config dir, socket, token, db, logs
gui/
  main.go                  Wails v3 host (thin)
  frontend/                Vite + React 19 + TypeScript + Tailwind v4 + shadcn + Zustand
docs/                      this file, PLAN.md, ADRs under docs/adr/
```

Module path: `github.com/awaumann/code-foundry`.

## 4. Protocol

Protobuf schemas under `proto/`, compiled with `buf`. Server is `connect-go`; the browser
client is `@connectrpc/connect-web`; the Go client is `connect-go`.

Transport:

| Client | Transport | Auth |
|---|---|---|
| CLI, Wails host | Unix socket `$CONFIG/daemon.sock` | filesystem permissions (0600) |
| Frontend | `http://127.0.0.1:<random port>` | bearer token from `$CONFIG/daemon.token` (0600) |

Both listeners serve the same handlers. The port and token are written by the daemon on
start; the Wails host reads them and injects them into the page before load.

Services (v1):

* `SessionService` — Create, Fork, List, Get, Rename, Close, Reconnect, Remove, Watch
  (server stream). A session carries lifecycle `state` (starting, connected, closing,
  disconnected) and detector `status` (busy, idle, needs-attention) with `status_reason`.
* `TerminalService` — Attach (server stream: initial screen snapshot then live output
  chunks), Write (input bytes), Resize, Detach.
* `RepoService` — Register, Unregister, List, ListWorktrees, CreateWorktree, Watch.
* `GhService` — ListPullRequests, GetChecks, Watch.
* `GitOpsService` — Fetch, Pull, Push, CreatePullRequest, OpenPullRequest, OpenEditor,
  Reveal, OpenUrl, List, Watch. One operation at a time per worktree; a failed operation
  is a result (state FAILED, output), not an RPC error. The GUI reaches it only through
  the git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url commands.
* `CommandService` — List(context) → available commands with their arg schemas; Invoke.
* `UiService` — WatchIntents (server stream: focus session, open palette, …); Emit (from
  CLI).
* `EventService` — Watch: one server stream that multiplexes every store's events and UI
  intents (sources repo, terminal, session, gh, gitops, ui; filterable). On connect it sends each
  source's snapshot in that order, then live events; a source that drops events for a
  slow client resends only its own snapshot. This is the GUI's only long-lived sync
  stream; the per-service Watch RPCs remain for the CLI and tests.
* `HealthService` — Ping, Version.

Rules:

* Streams carry `bytes` payloads for terminal output. Never base64, never re-encode.
* Every message type is owned by the service that emits it. No shared "misc" proto.
* Breaking changes bump the package version. v1 is append-only once Phase 1 lands.

## 5. Terminal store

One actor per terminal:

```
PTY (creack/pty) ──reader goroutine──► tee ──► libghostty-vt (feed)
                                          ├──► ring buffer (last 1 MiB of raw output)
                                          └──► attached subscribers (bounded channels)
```

* The actor is the only goroutine that touches its vt instance. cgo is not thread-safe
  across goroutines without serialization; we serialize by construction.
* `Attach` sends a **snapshot** built from the vt grid (rows with SGR attributes, cursor,
  alt-screen flag, scrollback when the binding exposes it), then live chunks. The snapshot
  is a byte sequence xterm.js can consume after a reset. If the binding cannot serialize
  scrollback, fall back to replaying the ring buffer for primary-screen history.
* Slow subscribers are dropped, not blocked. The PTY reader never stalls on a client.
* The terminal store is program-agnostic. It spawns argv/env/cwd. "This is Claude" is the
  session store's concern. A plain shell terminal is a first-class use.
* Resize is driven by the attached GUI terminal; the daemon applies it to the PTY and vt.
  With no attachment, size is the last known size.

## 6. Session store

Layers Claude-specific knowledge on top of terminal:

* Spawns `claude` in a worktree with the chosen model/effort flags, records the Claude
  session id (from `~/.claude/projects/<slug>/*.jsonl`) so dead sessions can be resumed
  with `claude --resume`.
* **Status detection** (busy / idle / needs-attention) derives from observing the output
  stream and the JSONL transcript. It is a pure function over observed events with table
  tests. It is never inferred from rendering.
* Auto-naming via an independent `claude -p` call producing a slug.
* Persists session metadata in SQLite so the sidebar can show resumable sessions after a
  daemon restart. v1 does not keep PTYs alive across daemon restarts.

## 7. Command registry

Every user-facing action is a `command.Command`:

```go
type Command struct {
    Name    string            // "session.close"
    Title   string            // "Close Session"
    Args    ArgSchema         // for CLI flags and palette prompts
    When    func(Context) bool // context-aware availability
    Run     func(context.Context, Context, Args) (Result, error)
}
```

`Context` is what the caller is looking at: active session, active repo/worktree, active
view. The GUI sends its context with `List` and `Invoke`; the CLI passes an explicit
context from flags or none. The palette, keybindings, and CLI subcommands are three front
doors to this one registry. Adding a feature means registering commands, not editing a
switch.

## 8. Frontend

* React 19, Vite, TypeScript strict, Tailwind v4, shadcn/ui, Zustand, `cmdk` for the palette.
* `@xterm/xterm` with `addon-webgl` (falls back to xterm's DOM renderer on context loss), `addon-fit`,
  `addon-web-links`. Terminal rendering sits behind a small `TerminalRenderer` interface so
  a libghostty-vt-fed grid renderer can replace it later.
* State discipline: sliced Zustand stores, one per daemon service. Streams update slices;
  components subscribe to the narrowest selector. Lists are virtualized. No global
  re-render on daemon events.
* Connection budget: the GUI holds exactly one `EventService.Watch` stream plus one
  `TerminalService.Attach` (the visible terminal). Everything else is unary. This keeps
  the browser's six HTTP/1.1 connections per origin mostly free.
* Only the visible terminal is attached. Switching sessions detaches the old stream and
  attaches the new one. Background sessions cost nothing in the frontend. Attaching is
  also how the daemon knows a session is being looked at: while a session's terminal has
  an Attach subscriber, finished turns count as seen (see
  `docs/notes/phase2-integration.md`).
* Layout: sidebar (repos → worktrees → sessions), content (terminal or overview page),
  footer with context-aware hints, command palette overlay. Keyboard-first; every palette
  command is reachable without the mouse.

## 9. Repo and GitHub stores

* `repo`: registered repositories and their worktrees. Shells out to `git` for worktree
  create/list/remove and status (branch, ahead/behind, dirty). One filesystem watcher
  (fsnotify) across all registered roots feeds a debounced reconcile. Workers write
  disjoint per-path snapshot pointers.
* `gh`: `gh api graphql` for PRs, checks, viewer. Polled on a paced loop; results cached in
  SQLite so startup is instant and offline is tolerable.

## 10. Conventions

* Features add files, not edits. Registries over switch statements. Messages owned by the
  emitter.
* Pure functions with table tests for anything with branches: status detection, layout,
  command availability, snapshot serialization.
* Every store has an interface in its own package and a fake in `<store>/<store>test`.
* Go 1.26 (required by the libghostty-vt bindings). `context.Context` first, errors wrapped with `%w`, no panics outside `main`.
* Logging: `log/slog`, JSON to `$CONFIG/logs/daemon.log`, text to stderr in dev.
* Frontend never imports generated protobuf types outside `src/api/`; it maps to view
  models at the boundary.

## 11. Non-goals for v1

* Cross-platform. macOS only.
* Keeping PTYs alive across daemon restarts.
* Remote daemons. The protocol allows it; nothing implements it.
* A custom terminal renderer. xterm.js is the renderer until measured otherwise.
