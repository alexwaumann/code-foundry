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
  token into the page. It also adopts the user's login-shell PATH when it was started
  with launchd's minimal one, auto-starts the daemon from the CLI installed next to it,
  and relaunches itself when the daemon asks (`app.relaunch`). No business logic lives
  in the Wails host.
* **CLI** subcommands (`code-foundry new-session --repo foo`, `code-foundry focus <id>`, …)
  are clients of the same daemon API. A Claude Code session running inside the app can call
  the CLI, so sessions can orchestrate other sessions.

Two binaries from one version stamp, installed side by side as plain executables (no
`.app` bundle; managed Macs often block unsigned bundles) in `~/.code-foundry/app`:
`Code Foundry` (the Wails GUI), `code-foundry` (daemon + CLI; `~/.local/bin/code-foundry`
links to it) and `VERSION` (the release tag the updater reads). `code-foundry gui` starts
the GUI next to it. `code-foundry daemon` runs the daemon in the foreground. Every client
auto-starts the daemon if the socket is absent. Packaging and updates:
`docs/notes/bare-binary-distribution.md` (layout and launch) on top of
`docs/notes/phase3d-packaging.md` (releases and the update flow).

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
    gh/                    GitHub GraphQL/REST polling over HTTP (token via gh), PR/CI cache
    gitops/                git/gh operations per worktree (fetch, pull, push, PR); editor, Finder, browser
    clone/                 gh repo clone into the projects dir with streamed output, then register
    project/               new projects in the projects dir (git init, register); gh repo create to publish
    update/                release checks via gh, installs with the embedded installer
    workspace/             branch sets: one branch as a worktree in several repos
                           (docs/notes/workspaces-1-store.md)
  db/                      SQLite (modernc.org/sqlite, WAL) + migrations
  client/                  Go client for the daemon API, used by CLI and the Wails host
  paths/                   XDG-ish paths: config dir, socket, token, db, logs, worktrees, projects
  fsx/                     the home-directory boundary and directory completion
gui/
  main.go                  Wails v3 host (thin)
  frontend/                Vite + React 19 + TypeScript + Tailwind v4 + shadcn + Zustand
  build/                   Wails build assets; darwin Taskfile builds the bare GUI executable
scripts/                   install.sh (embedded in the binary), package.sh, release.sh,
                           next-version.sh, ghostty-vt.sh
docs/                      this file, PLAN.md, ADRs under docs/adr/
```

Module path: `github.com/alexwaumann/code-foundry`.

## 4. Protocol

Protobuf schemas under `proto/`, compiled with `buf`. Server is `connect-go`; the browser
client is `@connectrpc/connect-web`; the Go client is `connect-go`.

Transport:

| Client | Transport | Auth |
|---|---|---|
| CLI, Wails host | Unix socket `$CONFIG/daemon.sock` | filesystem permissions (0600) |
| Frontend | `http://127.0.0.1:<random port>` | bearer token from `$CONFIG/daemon.token` (0600) |
| CLI inside a session | `CODE_FOUNDRY_ENDPOINT` (the loopback listener) | `CODE_FOUNDRY_TOKEN`; both set in every session's env, never auto-starts a daemon |

Both listeners serve the same handlers. The port and token are written by the daemon on
start; the Wails host reads them and injects them into the page before load.

Services (v1):

* `SessionService` — Create, Fork, List, Get, Rename, Close, Reconnect, Remove, RunIn,
  Pin (the user's pin, persisted; `docs/notes/workspaces-4-sidebar.md`), Watch (server stream), StageAttachment (images the first prompt refers to). Create can
  make the worktree first (`new_worktree`), start a thread in a workspace member
  (`workspace_id`) or in a new workspace (`new_workspace`), passes the first prompt as
  claude's positional argument, and carries a permission mode (never
  bypassPermissions); see `docs/notes/new-thread-composer.md` and
  `docs/notes/workspaces-2-launch.md`. A session carries lifecycle `state` (starting, connected, closing,
  disconnected) and detector `status` (busy, idle, needs-attention) with `status_reason`.
* `TerminalService` — Attach (server stream: initial screen snapshot then live output
  chunks), Write (input bytes), Resize, Detach.
* `RepoService` — Register (a git repository, or any folder as a project without git;
  "~" expands, the path must be absolute; the Add Project dialog's Local folder tab calls
  it directly, the CLI through `repo add <folder>`),
  Unregister, List, ListWorktrees, CreateWorktree (optionally fetching the base first),
  ListRefs, Watch, GetWorktreeDetail (files and log against the base branch, Phase 3a),
  InitGit (`git init` and an empty first commit in a project without git;
  `docs/notes/add-project-2-nogit.md`), SearchGitHub and LookupGitHub (GraphQL through
  the gh store, for the Add Project dialog), Clone (server stream: `gh repo clone` into
  `<config home>/projects/<owner>/<repo>`, output lines, then the registered project;
  `docs/notes/add-project-3-dialog.md`), Create (a new project in
  `<config home>/projects/<name>`: git init, an empty first commit, register),
  ListPublishOwners (the viewer and their organizations with the visibilities each
  allows when GitHub says) and Publish (`gh repo create --source --remote origin --push`
  for a git project without origin; gh's error verbatim;
  `docs/notes/add-project-4-create.md`).
* `GhService` — GetViewer, GetDashboard, GetRepoActivity, GetBranchPullRequests (the
  viewer's PR dashboards, monthly stats, default-branch CI, the viewer's PRs on a
  branch), GetPullRequest and ListChecks (on demand), Refresh, Track, Untrack, Watch.
  Data events go out only when data changed; `Polled` after every poll carries the
  freshness time. The PR detail panel: GetPullRequestDetail (on demand, cached per PR,
  invalidated by the poll's fingerprints), ListReviewerCandidates, SetReviewRequest,
  RevertPullRequest (`docs/notes/gh-pr-detail.md`).
* `GitOpsService` — Fetch, Pull, Push, CreatePullRequest, OpenPullRequest, OpenEditor,
  Reveal, OpenUrl, List, Watch. One operation at a time per worktree; a failed operation
  is a result (state FAILED, output), not an RPC error. The GUI reaches it only through
  the git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url commands.
* `CommandService` — List(context) → available commands with their arg schemas; Invoke.
* `UiService` — WatchIntents (server stream: focus session, open palette, …); Emit (from
  CLI).
* `EventService` — Watch: one server stream that multiplexes every store's events and UI
  intents (sources repo, workspace, terminal, session, gh, gitops, settings, update, ui;
  filterable). On connect it sends each source's snapshot in that order, then live events; a source that drops events for a
  slow client resends only its own snapshot. This is the GUI's only long-lived sync
  stream; the per-service Watch RPCs remain for the CLI and tests.
* `SettingsService` — GetSchema, Get, Update, Watch over `$CONFIG/settings.toml` (TOML,
  hand-editable, reloaded on change). See `docs/notes/phase3b-settings.md`.
* `UpdateService` — Get, Check, Install, Relaunch, Watch. The 24h release check, install
  progress, and relaunch requests. Nothing restarts automatically; `daemon.restart`
  (a confirmed command: it closes every live session) exits, and the next client starts
  the installed binary.
* `WorkspaceService` — List, Create, AddRepo, RemoveRepo, Remove, Members (by id, name,
  or a path inside a member worktree), Watch. See `docs/notes/workspaces-1-store.md`.
  The GUI gets workspaces from EventService's `workspace` source (a `workspaces` slice),
  and the composer starts threads in them (`docs/notes/workspaces-3-composer.md`).
* `FilesystemService` — ListDirectories: completes a typed path prefix to directories
  under the user's home (is_git, registered, common completion), for the palette's
  `path` prompts and the Add Project dialog's Local folder tab. Every project path must resolve under home; `repo.Register` enforces
  it too (`docs/notes/add-project-1-paths.md`).
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

* Spawns `claude` in a worktree with the chosen model/effort/permission-mode flags and
  the first prompt as a positional argument, records the Claude
  session id (from `~/.claude/projects/<slug>/*.jsonl`) so dead sessions can be resumed
  with `claude --resume`.
* A thread has one owner: its workspace when `workspace_id` is set, else its project
  (`repo_id`). `repo_id`/`worktree_path` are the cwd. Every spawn of a workspace thread
  (create, reconnect, fork) reads the workspace's current members from the workspace
  store and adds `--add-dir` for each other member,
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, and one static
  `--append-system-prompt` line pointing at `code-foundry workspace members`.
  `SessionService.RunIn` moves a workspace thread to another member by typing `/cd`
  once it is idle at its prompt (`docs/notes/workspaces-2-launch.md`).
* **Status detection** (busy / idle / needs-attention) derives from observing the output
  stream and the JSONL transcript. It is a pure function over observed events with table
  tests. It is never inferred from rendering.
* Auto-naming via an independent `claude -p` call producing a slug.
* **Linked pull requests** come from Claude's own `pr-link` transcript records: every
  distinct URL in first-seen order, persisted in `session_pull_requests`, backfilled from
  the transcript's history when a thread is resumed (`docs/notes/linked-prs.md`).
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
view, and the workspace that owns the active thread or composer (so `session.run-in` is
offered for workspace threads only). The GUI sends its context with `List` and `Invoke`;
the CLI passes an explicit context from flags or none. The palette, keybindings, and CLI subcommands are three front
doors to this one registry. Adding a feature means registering commands, not editing a
switch.

Pull request commands: the detail panel's actions (`pr.merge`, `pr.revert`,
`pr.review.request`, `pr.refresh`; docs/notes/gh-pr-detail.md) and the session starters `pr.ask`,
`pr.explain`, `pr.fix.findings`, which pick or create a worktree and type a prompt built
from the pull request (docs/notes/pr-thread-commands.md).

## 8. Frontend

* React 19, Vite, TypeScript strict, Tailwind v4, shadcn/ui, Zustand, `cmdk` for the palette.
* `@xterm/xterm` with `addon-webgl` (falls back to xterm's DOM renderer on context loss), `addon-fit`,
  `addon-web-links`. Terminal rendering sits behind a small `TerminalRenderer` interface so
  a libghostty-vt-fed grid renderer can replace it later.
* State discipline: sliced Zustand stores, one per daemon service. Streams update slices;
  components subscribe to the narrowest selector. Lists are virtualized. No global
  re-render on daemon events.
* Connection budget: the GUI holds exactly one `EventService.Watch` stream plus one
  `TerminalService.Attach` (the visible terminal). Everything else is unary, except a
  `RepoService.Clone` stream while the Add Project dialog clones a repository. This keeps
  the browser's six HTTP/1.1 connections per origin mostly free.
* Only the visible terminal is attached. Switching sessions detaches the old stream and
  attaches the new one. Background sessions cost nothing in the frontend. Attaching is
  also how the daemon knows a session is being looked at: while a session's terminal has
  an Attach subscriber, finished turns count as seen (see
  `docs/notes/phase2-integration.md`).
* Layout: a draggable title strip under the hidden-inset traffic lights, sidebar (Pull
  Requests and Projects entries, then a flat thread list: Pinned and Needs attention
  sections on top, threads newest first with project, branch, status and a workspace
  badge, then terminals no thread owns; a status row at its foot; see
  `docs/notes/workspaces-4-sidebar.md`), content (terminal, the Pull Requests page, the
  Projects page with each project's worktrees and each workspace's members, or the
  composer; a worktree's overview is a side panel tab, not a page), command palette
  overlay. Strip and sidebar sit on one background (the sheet);
  the content is a rounded pane on it (see `docs/notes/phase3-ui-panes.md`). Each
  selection can open a side panel right of the content: a second pane with tabs whose
  bodies come from the surface registry (`src/surfaces`, `docs/notes/side-panel.md`):
  Files and Diff (placeholders), Pull request, whose menu starts sessions about the pull
  request through `pr.ask`, `pr.explain` and `pr.fix.findings`, Workspace (a workspace
  thread's members with their git, PR and CI state, add/remove, Run in; opened by W,
  `view.panel.workspace`, the sidebar's workspace badge, the thread header and the
  Projects page), Worktree (one worktree's overview as a tab: a thread's own worktree
  by T or `view.panel.worktree`, a project or worktree row on the Projects page by Enter
  or double-click into the page's own panel, a member from the Workspace surface;
  `docs/notes/worktree-panel-tab.md`, `docs/notes/workspaces-5-panel.md`) and Linked PRs (the
  thread's linked pull requests, newest first, each opening as a PR tab; opened by L,
  `view.panel.linked-prs`, the thread header and the sidebar's PR badge;
  `docs/notes/linked-prs.md`). Every
  palette command is reachable without the mouse, and common ones also have buttons that
  invoke the same registry command. Chords are listed only in the palette and the
  Keyboard Shortcuts overlay (`docs/notes/phase3-ui-buttons.md`).

## 9. Repo and GitHub stores

* `repo`: registered repositories and their worktrees. Shells out to `git` for worktree
  create/list/remove and status (branch, ahead/behind, dirty). One filesystem watcher
  (fsnotify) across all registered roots feeds a debounced reconcile. Workers write
  disjoint per-path snapshot pointers. A project may be a plain folder (`Repo.Git`
  false): one synthetic checkout, no git commands or watches, the poll notices a later
  `git init` (`docs/notes/add-project-2-nogit.md`).
* `gh`: GitHub GraphQL (and a little REST) sent in-process over one keep-alive HTTP
  client with the token from `gh auth token` (github.com only; see
  `docs/notes/gh-http-transport.md`). Scoped to the viewer: their PRs (authored, review
  requested, reviewed, recently merged), tracked repositories' default-branch CI, and
  their PRs on watched branches. One fingerprint request per poll interval; details only
  for what changed (`docs/notes/gh-viewer-polling.md`). Results cached in SQLite so
  startup is instant and offline is tolerable.

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
