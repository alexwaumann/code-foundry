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

* **Daemon** (`code-foundry daemon`) owns PTYs and terminal emulation (libghostty-vt) for
  shells, the Claude session lifecycle (claude -p over stream-json) and its status, git
  and GitHub workers, SQLite, and the command registry. It never renders. It outlives the window: closing or crashing the GUI
  does not kill threads.
* **GUI** is a Wails v3 shell hosting a React frontend. The frontend talks to the daemon
  *directly* with Connect-Web over a loopback HTTP listener. The Go host process in Wails is
  deliberately thin: window, menu, native dialogs, and injecting the daemon's address and
  token into the page. It also adopts the user's login-shell PATH when it was started
  with launchd's minimal one, auto-starts the daemon from the CLI installed next to it,
  and relaunches itself when the daemon asks (`app.relaunch` at once, `app.restart` once
  the daemon has exited). It sets the Dock badge, bounces the Dock icon and plays the
  alert sound (NSSound, an embedded WAV) when the frontend asks (`SetBadge`, `Bounce`,
  `PlaySound`; the frontend's `stores/dockAlerts.ts` decides from the threads and the
  `notifications.*` settings, and `notifications.test` previews the sound through a
  `PlayAlertSound` UI intent; no notification banners for a bare executable,
  `docs/notes/dock-alerts.md`). It paints the window behind the page in the active
  theme's sheet and keeps those colours for the next launch (`SetWindowBackground`,
  `window-background.json` in the config home; `docs/notes/theme-engine-3-settings.md`).
  No business logic lives in the Wails host.
* **CLI** subcommands (`code-foundry thread new --project foo`, `code-foundry focus <id>`, …)
  are clients of the same daemon API. A Claude Code session running inside the app can call
  the CLI, so threads can orchestrate other threads.

Two binaries from one version stamp, installed side by side as plain executables (no
`.app` bundle; managed Macs often block unsigned bundles) in `~/.code-foundry/app`:
`Code Foundry` (the Wails GUI), `code-foundry` (daemon + CLI; `~/.local/bin/code-foundry`
links to it) and `VERSION` (the release tag the updater reads). `code-foundry gui` starts
the GUI next to it. `code-foundry daemon` runs the daemon in the foreground. Every client
auto-starts the daemon if the socket is absent. Packaging and updates:
`docs/notes/bare-binary-distribution.md` (layout and launch) on top of
`docs/notes/phase3d-packaging.md` (releases and the update flow). Releases come in two
channels: a `vX.Y.Z-tip.N` prerelease per push to main, and stables promoted with `make
promote` (`docs/notes/release-channels-handoff.md`).

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
    thread/                threads: claude -p over stream-json, items, naming, status, resume
    claudestream/          the stream-json / control protocol client (pure Go)
    project/               registered projects, worktrees, git status, FSEvents stream
    gh/                    GitHub GraphQL/REST polling over HTTP (token via gh), PR/CI cache
    gitops/                git/gh operations per worktree (fetch, pull, push, PR); editor, Finder, browser
    clone/                 gh repo clone into the projects dir with streamed output, then register
    newproject/            new projects in the projects dir (git init, register); gh repo create to publish
    update/                release checks via gh (stable or tip channel), downloads and installs with the embedded installer
    workspace/             branch sets: one branch as a worktree in several projects
                           (docs/notes/workspaces-1-store.md)
    action/                per-project actions (named command lines) and their runs, in a
                           kind=action terminal or in the background with captured output
                           (docs/notes/actions-1-daemon.md)
    plugin/                plugins: discovery, consent, one actor per enabled plugin (stdio
                           JSON-RPC), plugin.<name>.* commands, Keychain secrets
                           (docs/notes/plugins-1-core.md)
  childproc/               a child process in its own group with owned pipes (Claude, plugins)
  db/                      SQLite (modernc.org/sqlite, WAL) + migrations; refuses a database
                           migrated by a newer build (db.ErrNewerSchema)
  client/                  Go client for the daemon API, used by CLI and the Wails host
  paths/                   XDG-ish paths: config dir, socket, token, db, logs, worktrees, projects
  guide/                   the agent guide and the skills' references, rendered from commands and settings
  skills/                  the Claude Code skills written for every thread at daemon start
  fsx/                     the home-directory boundary and directory completion
pluginsdk/                 the plugin SDK, its own module (stdlib only): manifest, protocol, Serve,
                           Host, ui (view model), plugintest (docs/notes/plugins-1-core.md)
plugins/examples/          example plugins (hello), built by `make plugins`
gui/
  main.go                  Wails v3 host (thin)
  frontend/                Vite + React 19 + TypeScript + Tailwind v4 + shadcn + Zustand
  build/                   Wails build assets; darwin Taskfile builds the bare GUI executable
scripts/                   install.sh (embedded in the binary), package.sh, release.sh,
                           next-version.sh, ghostty-vt.sh
docs/                      this file, PLAN.md, ADRs under docs/adr/, GETTING-STARTED.md (embedded by
                           embed.go, package docs, for the help skill)
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
| CLI inside a thread | `CODE_FOUNDRY_ENDPOINT` (the loopback listener) | `CODE_FOUNDRY_TOKEN`; both set in every thread's Claude env, never auto-starts a daemon |

Every Claude process also gets `CODE_FOUNDRY_THREAD=<its thread id>`, which the CLI sends
as its default `--context-thread`: an agent's `code-foundry terminal new` or `action run`
lands in its own thread's bottom panel (`docs/notes/actions-1-daemon.md`).

Both listeners serve the same handlers. The port and token are written by the daemon on
start; the Wails host reads them and injects them into the page before load.

Services (v1):

* `ThreadService`, the lifecycle — Create, Fork, List, Get, Rename, Remove, RunIn,
  Pin (the user's pin, persisted; `docs/notes/workspaces-4-sidebar.md`), Archive (close,
  remove the thread's shells, unpin, stamp `archived_at`; pin and send
  unarchive; `docs/notes/archive-threads-1-daemon.md`), Snooze (close, remove the
  thread's shells, unpin, unarchive, set `snoozed_until`; the store wakes it on the wall
  clock into NEEDS_ATTENTION "snooze ended"; `docs/notes/snooze-threads-1-daemon.md`), Watch (server stream of every thread), Wait (block until a thread is idle, needs attention, has an error or is disconnected; `thread.wait`, `docs/notes/agents-1-wait-events.md`), Label, Report and SetBudget (agent metadata: labels, a report, a spending limit whose budget stop interrupts Claude into NEEDS_ATTENTION "budget reached"; with Create's created_by and brief, `docs/notes/agents-2-metadata.md`), Subscribe, Unsubscribe and ListSubscriptions (wake subscriptions: the daemon sends a thread a wake message, a user message with origin WAKE, when a target thread settles or meets another condition, or an action run finishes; persisted, edge-triggered from the thread store's commit, 60 per subscriber per hour; `thread.new --notify`; `docs/notes/agents-4-wake.md`), StageAttachment (images and PDFs a message refers to; `docs/notes/pdf-attachments-1-daemon.md`).
  Close and Reconnect remain in the proto for compatibility; no command calls them: the
  daemon starts a thread's process when a message is sent and stops it once the thread
  has idled at its prompt past its prompt cache expiry
  (`docs/notes/thread-lifecycle.md`). Create can
  make the worktree first (`new_worktree`), start a thread in a workspace member
  (`workspace_id`) or in a new workspace (`new_workspace`), or without a project in the
  home directory (`no_project`; `docs/notes/no-project-1-daemon.md`; the GUI's "No
  project" picker row and composer: `docs/notes/no-project-2-gui.md`), sends the first prompt as
  the thread's first user message, and carries a permission mode (never
  bypassPermissions); see `docs/notes/new-thread-composer.md` and
  `docs/notes/workspaces-2-launch.md`. Every thread runs headless (`claude -p` over
  stream-json, no terminal; the conversation is ThreadService items). The terminal
  thread mode (Claude's own interface in a PTY) was removed on 2026-10-12
  (`docs/notes/rendered-only.md`). A thread carries lifecycle `state` (starting,
  connected, closing, disconnected; the daemon's business, internal to clients: the GUI
  never shows it, `docs/notes/hide-connection-state.md`) and
  `status` (busy, idle, needs-attention; error when the process ended mid-turn or did
  not start) with `status_reason` and `status_changed_at`,
  persisted (`docs/notes/thread-status-persistence.md`).
* `ThreadService` — the conversation: ListItems, Watch (server stream: an items
  snapshot, then appended/updated items, text deltas and pending-request changes, all
  seq-ordered; an open Watch marks the thread's turns seen),
  Send (also while busy; a stopped thread starts with the message), Respond (a permission request or AskUserQuestion: allow,
  allow for session, deny with a reason, answers), Interrupt, SetModel,
  SetPermissionMode, SetEffort (Claude has no live effort switch: the runner restarts
  the process with `--resume` and the new `--effort`, at once when idle, else when the
  running turn ends, `Thread.effort_pending` meanwhile; the thread stays connected; the
  new process gets the thread's allow-for-session grants again as `--allowedTools` /
  `--add-dir`; a stopped thread's model, mode and effort changes only go to its row), McpStatus and McpReconnect (the thread's MCP servers as Claude last
  reported them, checked at the start of every turn, kept and persisted while the thread
  is stopped; a refresh or reconnect starts a stopped thread without a prompt; Watch carries
  each check; `docs/notes/mcp-panel.md`), SlashCommands (the commands Claude reports in its
  initialize reply and `commands_changed` pushes, minus a daemon-side deny table, kept and
  persisted while the thread is stopped; the items snapshot and Watch carry them; Send refuses a message starting with
  a command the app replaces, such as `/clear`; `docs/notes/slash-commands-1-daemon.md`).
  The items snapshot and Watch also carry the thread's subagent runs (`agents`: every
  Agent run, foreground, background and nested, in spawn order, with live status,
  activity and report; `docs/notes/agents-1-daemon.md`).
  See `docs/notes/rendered-threads-1-daemon.md`
  and `docs/notes/rendered-threads-3-interaction.md`.
* `TerminalService` — Attach (server stream: initial screen snapshot then live output
  chunks), Write (input bytes), Resize, Detach, Kill, Remove, and Close (kill, wait for
  the exit, remove; shells only).
* `ProjectService` — Register (a git repository, or any folder as a project without git;
  "~" expands, the path must be absolute; the Add Project dialog's Local folder tab calls
  it directly, the CLI through `project add <folder>`),
  Unregister, List, ListWorktrees, CreateWorktree (optionally fetching the base first),
  CleanupWorktrees (remove worktrees whose work is in origin/<default>: `merged_clean`,
  no thread (archived ones aside), terminal or workspace on it; never deletes branches;
  `docs/notes/projects-polish-3.md`),
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
  viewer's PR dashboards, six months of stats (`docs/notes/gh-stats-six-months.md`),
  default-branch CI, the viewer's PRs on a branch), GetPullRequest and ListChecks (on demand), Refresh, Track, Untrack, Watch.
  Data events go out only when data changed; `Polled` after every poll carries the
  freshness time. The PR detail panel: GetPullRequestDetail (on demand, cached per PR,
  invalidated by the poll's fingerprints), ListReviewerCandidates, SetReviewRequest,
  RevertPullRequest (`docs/notes/gh-pr-detail.md`), SubmitPullRequestReview and
  AddPullRequestComment (GitHub's refusals relayed as FAILED_PRECONDITION;
  `docs/notes/pr-review-submit-1-daemon.md`).
* `GitOpsService` — Fetch, Pull, Push, CreatePullRequest, OpenPullRequest, OpenEditor,
  Reveal, OpenUrl, List, Watch. One operation at a time per worktree; a failed operation
  is a result (state FAILED, output), not an RPC error. The GUI reaches it only through
  the git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url commands.
* `CommandService` — List(context) → available commands with their arg schemas; Invoke.
* `UiService` — WatchIntents (server stream: focus thread, open palette, …); Emit (from
  CLI).
* `EventService` — Watch: one server stream that multiplexes every store's events and UI
  intents (sources project, workspace, terminal, thread list, thread, gh, gitops, settings,
  update, action, plugin, ui; the thread source carries threads' pending requests only, a
  snapshot then changes, never items; filterable). On connect it sends each source's snapshot in that order, then live events; a source that drops events for a
  slow client resends only its own snapshot. This is the GUI's only long-lived sync
  stream; the per-service Watch RPCs remain for the CLI and tests. Live events pass
  through one hub that numbers them (`Event.seq`, one daemon-wide sequence) and keeps
  the last 4096; `since_seq` resumes a stream without snapshots while they cover it
  (`code-foundry events --since`; `docs/notes/agents-1-wait-events.md`). Every event
  carries the daemon's `epoch` (drawn at startup); a `since_epoch` of another daemon
  starts over with snapshots (`docs/notes/agents-5-cli.md`). The GUI opens it as
  `client_kind` GUI with a per-stream `client_id` and its visibility, and updates that
  with SetClientState; the registry of GUI clients paces the GitHub poll
  (`docs/notes/gh-poll-tiers.md`).
* `SettingsService` — GetSchema, Get, Update, Watch over `$CONFIG/settings.toml` (TOML,
  hand-editable, reloaded on change). See `docs/notes/phase3b-settings.md`.
* `UpdateService` — Get, Check, Download, Install, Relaunch, RequestRestart, Watch. The
  24h release check on the `update.channel` setting's channel (stable: the newest full
  release; tip: the highest release, prereleases included; re-checked at once when the
  setting changes; `Newer` is the only install rule, so no switch offers a downgrade),
  download progress, and relaunch and restart requests. Download (`app.update`) only
  stages the release in `app.new`; the install on disk changes inside the restart, so a
  window reopened meanwhile still matches its daemon. Nothing restarts automatically.
  `app.restart` (the GUI's "Restart Now"; confirmed, warning about busy threads) installs
  a downloaded update (two renames), publishes `restart_requested`, then the daemon exits
  like `daemon.restart`; GUI hosts relaunch once their Watch stream ends and the new
  window auto-starts the installed daemon. `app.relaunch` and `daemon.restart` restart
  the halves separately and install nothing. See `docs/notes/update-restart.md`,
  `docs/notes/update-download-then-install.md` and `docs/notes/release-channels.md`.
* `WorkspaceService` — List, Create, AddProject, RemoveProject, Remove, Members (by id, name,
  or a path inside a member worktree), Watch. See `docs/notes/workspaces-1-store.md`.
  The GUI gets workspaces from EventService's `workspace` source (a `workspaces` slice),
  and the composer starts threads in them (`docs/notes/workspaces-3-composer.md`).
* `FilesystemService` — ListDirectories: completes a typed path prefix to directories
  under the user's home (is_git, registered, common completion), for the palette's
  `path` prompts and the Add Project dialog's Local folder tab. Every project path must resolve under home; `project.Register` enforces
  it too (`docs/notes/add-project-1-paths.md`). ListSkills (`.claude/skills` and
  `.claude/commands` of given checkouts, plus the user's) and SearchFiles (fuzzy match over
  a checkout's git-listed or walked files, cached ~5s) feed the composer's `/` and `@`
  completion (`docs/notes/composer-tags-1-daemon.md`; the GUI's tags and `/` card:
  `docs/notes/composer-tags-3-skills.md`; the `@` card: `docs/notes/composer-tags-4-files.md`).
* `ActionService` — List, Create, Update, Delete, Run, GetRun, WaitRun, Watch. Per-project
  actions (name unique per project ignoring case, command, icon, in terminal or in the
  background, run on worktree create, position; SQLite, cascading with the project) and
  their runs (in memory, 50 per project). A run belongs to a thread or a worktree like a
  shell, runs `$SHELL -lc <command>` there with `CODE_FOUNDRY_PROJECT_ROOT` and
  `CODE_FOUNDRY_WORKTREE`, in a `kind=action` terminal or as a background process whose
  last 64 KiB of output WaitRun returns. A new thread's worktree runs the project's
  on-worktree-create actions in the background; `run_finished` events carry every end
  (`docs/notes/actions-1-daemon.md`). The action.* commands are the CLI's surface.
* `PluginService` — List, Enable (with consent, else the text to consent to), Disable,
  Restart, Dev (link a folder and enable it), Reload, Logs, FollowLogs, ListSecrets,
  DeleteSecret, Watch. Plugins are executables in `$CONFIG/plugins/<name>` the daemon runs
  and speaks newline-delimited JSON-RPC 2.0 with over stdio; their manifest commands are
  `plugin.<name>.<command>` (`docs/notes/plugins-1-core.md`; design in
  `docs/sketches/plugins/`).
  WatchSurface, GetSurface and Act serve plugin surfaces: views (the `pluginsdk/ui`
  JSON the daemon validates) per instance `<plugin>/<surface>/<scope>`, opened on the
  first watcher; each surface's `plugin.<name>.show.<surface>` command carries its
  availability (a when clause over host facts) in CommandService.List
  (`docs/notes/plugins-2-surfaces.md`).
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
* The terminal store is program-agnostic. It spawns argv/env/cwd. Shells are its only
  production use since threads run headless; its Observer and ScreenText hooks remain
  for a future program that wants them.
* Resize is driven by the attached GUI terminal; the daemon applies it to the PTY and vt.
  With no attachment, size is the last known size.
* Labels are opaque to the store; their contract lives in `internal/termlabel`: `kind`
  (`shell` on a shell `terminal.new` started, `action` on an action run in a terminal),
  `thread` (the owning thread), `project` and `worktree` (the owning worktree), and on
  action terminals `action`, `action.name` and `action.run`. `terminal.new`
  gives every shell an owner (thread, else worktree) and refuses a cwd outside every
  registered project. The shell reaper (`internal/daemon/shells.go`) removes a shell when
  it exits or when its worktree, project or thread goes away, with a periodic sweep for
  dropped events (`docs/notes/bottom-panel-1-daemon.md`). An exited action terminal stays
  (the user reads its output; the GUI closes it), but goes with its owner like a shell
  (`docs/notes/actions-1-daemon.md`).

## 6. Thread store

Owns the Claude processes. It uses the terminal store only to reap a thread's shells.

* Spawns `claude -p` over stream-json in a worktree with the chosen
  model/effort/permission-mode flags through `internal/claudestream` and sends the first
  prompt as the first user message (with image blocks; see below). It records the Claude
  session id (from `~/.claude/projects/<slug>/*.jsonl`) so dead threads can be resumed
  with `claude --resume`.
* A thread has at most one owner: its workspace when `workspace_id` is set, else its
  project when `project_id` is set, else none: a thread without a project runs in the home
  directory (`Options.Home`), pre-trusted like any cwd, and RunIn refuses it
  (`docs/notes/no-project-1-daemon.md`). `project_id`/`worktree_path` are the cwd. Every spawn of a workspace thread
  (create, a start on send, fork) reads the workspace's current members from the workspace
  store and adds `--add-dir` for each other member,
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, and one static
  `--append-system-prompt` line pointing at `code-foundry workspace members`, after the
  static line every thread gets pointing at the skills below (`ThreadPrompt`;
  `docs/notes/agents-5-cli.md`, `docs/notes/agent-skills.md`).
* **Skills**: at every start the daemon writes two Claude Code skills,
  `code-foundry-orchestrate` (delegating work to other threads) and `code-foundry-help`
  (how-to questions about the app), to `<config home>/claude/.claude/skills`
  (`internal/skills`: static SKILL.md files embedded, references rendered from the
  registry and the settings schema through `internal/guide`, `docs/GETTING-STARTED.md`
  embedded by the `docs` package). Every spawn passes `<config home>/claude` as its first
  `--add-dir`, before the attachments dir, workspace members and grants
  (`docs/notes/agent-skills.md`).
  `ThreadService.RunIn` moves a workspace thread to another member with the control
  protocol's `set_cwd` once it is idle (`docs/notes/workspaces-2-launch.md`, superseded
  on the typing detail by `docs/notes/rendered-only.md`).
* **Status** (busy / idle / needs-attention) comes from the stream, never from a screen:
  busy from send to `result`, needs-attention while a `can_use_tool` or question is
  pending, finished until seen, error when the process exits mid-turn. The status is
  persisted: a stopped thread keeps the one it ended with (busy becomes error
  "interrupted"), across daemon restarts, until the next start replaces it
  (`docs/notes/thread-status-persistence.md`; its screen detector is gone).
* **Lifecycle** (`lifecycle.go`): a message to a stopped thread reserves it, writes the
  user item and resumes the conversation with the message as the first prompt (a failed
  start is an error item and status error); every 30 s the store stops threads idle at
  their prompt past their prompt cache expiry (nothing pending, unfinished, queued or
  running in the background; up at least 5 minutes), disconnect reason "idle"
  (`docs/notes/thread-lifecycle.md`). A start of a thread whose worktree the app made and
  a cleanup removed makes it again first, on the branch the row records, at the same
  path, so `--resume` finds the transcript; workspace threads and user checkouts keep the
  refusal (`recreate.go`, `docs/notes/recreate-worktree.md`).
* **The runner** (`runner.go`, `stream.go`): `internal/claudestream` speaks the control
  protocol (initialize handshake, `can_use_tool` routed to the store, interrupt,
  set_model, set_permission_mode, set_cwd for RunIn). The stream is projected into
  `thread_items` (user message, assistant text, thinking, tool call, permission request,
  question, turn end, error, compaction, command output): streaming items stay in memory
  and are written when complete, so a restart rehydrates them and a resumed process appends.
  Every turn ends with a turn end: when the process ended before Claude's result (a close,
  a crash, a daemon stop or a daemon that died), the daemon writes one itself, subtype
  `process_ended` (`turnclose.go`, `docs/notes/thread-fold-1-daemon.md`).
  A `note` item is the daemon's own line, not the stream's: a fork's items start as a
  copy of its parent's (never live: pending requests cancelled, running tools ended),
  then the note "Forked from <parent>" (`fork.go`, `docs/notes/fork-copies-history.md`).
  Transcript tailing (naming, usage, PR links, `/clear`) reads Claude's own JSONL beside
  the stream (`docs/notes/rendered-threads-1-daemon.md`). Each turn end carries the turn's own cost
  (Claude reports running totals per process; a process's first turn is measured from
  what Claude restores on `--resume`, the resumed transcript's last `cost-state` record,
  read at spawn; unset when the totals do not fit) and the model that replied
  (`docs/notes/rendered-threads-4-optin.md`). Each result also records the thread's
  context size (the last top-level response's tokens) and when, persisted; the cache
  expiry is that plus the `threads.cache_ttl_seconds` setting, and the composer says
  when the next message re-reads a cold context
  (`docs/notes/rendered-threads-cold-cache.md`).
* Auto-naming via an independent `claude -p` call producing a short natural title
  ("Fix the login redirect"); a new worktree's branch is `cf/` + the title's slug
  (`docs/notes/natural-thread-names.md`). Until it answers, a thread with a first prompt
  has a provisional name, the prompt's first line or sentence cut to 48 characters
  (`name_provisional`, `provisional.go`); the title replaces it, a rename clears it, the
  branch never uses it (`docs/notes/provisional-names.md`). Once a thread whose worktree Create made has
  started, `Options.WorktreeCreated` hands the worktree to the daemon, which runs the
  project's on-worktree-create actions in the background (the thread store does not
  know about actions; `docs/notes/actions-1-daemon.md`).
* **Linked pull requests** come from Claude's own `pr-link` transcript records: every
  distinct URL in first-seen order, persisted in `thread_pull_requests`, backfilled from
  the transcript's history when a thread is resumed (`docs/notes/linked-prs.md`).
* **Token usage** is a pure fold over assistant records (each request once), per
  (model, tier, speed, UTC day), summed over the thread's sources: every transcript it
  used (`/clear` starts a new one) and every subagent run under them, followed from the
  transcripts' own Agent tool records. The total is persisted in `thread_usage`, each
  source in `thread_source_usage`, runs in `thread_agent_runs`; values are only ever
  replaced by complete folds (a resume rescans every source from byte zero). Removing a
  thread adds its buckets to `usage_retired`. Cost is priced at read time by
  `internal/pricing` (`docs/notes/session-usage.md`).
* **Subagent runs** are the same records, live: the stream's task frames give each run
  its lifecycle (running, done, failed; activity, Claude's counters, report or error; a
  SendMessage wake runs again in place), persisted with the run. A background run's
  Agent call stays running until the run ends, which adds a note item. Runs still
  running when their process ends fail: subagents run inside it
  (`docs/notes/agents-1-daemon.md`).
* Persists thread metadata in SQLite so the sidebar can show resumable threads after a
  daemon restart. v1 does not keep Claude processes alive across daemon restarts.

## 7. Command registry

Every user-facing action is a `command.Command`:

```go
type Command struct {
    Name    string            // "thread.rename"
    Title   string            // "Rename Thread"
    Args    ArgSchema         // for CLI flags and palette prompts
    When    func(Context) bool // context-aware availability
    Run     func(context.Context, Context, Args) (Result, error)
}
```

`Context` is what the caller is looking at: active thread, active project/worktree, active
view, and the workspace that owns the active thread or composer (so `thread.run-in` is
offered for workspace threads only; the `thread.*` commands,
send/respond/interrupt/items/set-model/set-mode/set-effort/mcp/mcp-reconnect/commands/agents, are
offered whenever a thread is active). The GUI sends its context with `List` and `Invoke`;
the CLI passes an explicit context from flags or none. The palette, keybindings, and CLI subcommands are three front
doors to this one registry. Adding a feature means registering commands, not editing a
switch.

Agents drive threads through the same registry (`docs/notes/agents-5-cli.md`): an arg
with an `IDKind` (thread, action run, subscription, terminal) takes a unique suffix of
the id, resolved by `Invoke` through the lister its domain registered; `thread.list`
filters in the daemon (`ListThreadsRequest.filter`); `thread.new --request-id` is
idempotent (`thread_requests`); `thread.read` pages items; `thread.send --wait` and
`thread.wait --after` wait for the turn after a message. `code-foundry guide` (a local
verb, like `--help`) prints a Markdown guide for agents generated from `CommandService.List`
(`internal/guide`, which also renders the skills' command references).

Pull request commands: the detail panel's actions (`pr.merge`, `pr.revert`,
`pr.review.request`, `pr.refresh`; docs/notes/gh-pr-detail.md; `pr.review`, `pr.comment`;
docs/notes/pr-review-submit-1-daemon.md, with the panel's Review menu in
docs/notes/pr-review-submit-2-gui.md) and the thread starters `pr.ask`,
`pr.explain`, `pr.fix.findings`, which pick or create a worktree and type a prompt built
from the pull request (docs/notes/pr-thread-commands.md). The panel's Code tab is read-only
and has no commands: it reads `GhService.GetPullRequestDiff` and renders it in one
virtualized `@pierre/diffs` CodeView (docs/notes/file-viewer-5-pr-code-tab.md).

## 8. Frontend

* React 19, Vite, TypeScript strict, Tailwind v4, shadcn/ui, Zustand, `cmdk` for the palette.
* `@xterm/xterm` with `addon-webgl` (falls back to xterm's DOM renderer on context loss), `addon-fit`,
  `addon-web-links`. Terminal rendering sits behind a small `TerminalRenderer` interface so
  a libghostty-vt-fed grid renderer can replace it later.
* State discipline: sliced Zustand stores, one per daemon service. Streams update slices;
  components subscribe to the narrowest selector. Lists are virtualized. No global
  re-render on daemon events.
* Connection budget: the GUI holds exactly one `EventService.Watch` stream plus at most
  two long-lived streams: the content pane's `ThreadService.Watch` and the bottom
  panel's active shell `TerminalService.Attach`, each only while it is visible. Everything else is unary, except a
  `ProjectService.Clone` stream while the Add Project dialog clones a repository. This keeps
  the browser's six HTTP/1.1 connections per origin mostly free.
* Stream liveness: the daemon sends a `StreamHeartbeat` on each of those three streams
  after 5 s without other messages (`api.HeartbeatInterval`, mirrored by
  `api/stream.ts` `HEARTBEAT_MS`). WKWebView can hold a stream's last bytes after the
  window was hidden, minimized or covered until more bytes arrive; the heartbeat releases
  them. `runStream` reconnects an attempt that heartbeated and then went silent for three
  intervals, and the thread Watch (`resyncOnVisible`) reopens for a fresh snapshot when
  the page becomes visible again (`docs/notes/thread-render-stall.md`).
* A thread's content pane is `components/thread`: a virtualized
  work-log timeline built from the items' structure (`lib/threadTimeline.ts`; text deltas
  re-render only their row), turns that fold under their header the moment they finish (the
  latest too), inline diffs on `components/code` (@pierre/diffs, themed from the app's syntax
  colours by `lib/codeTheme.ts`; `docs/notes/file-viewer-2-code-foundation.md`),
  lowlight-highlighted markdown in the terminal palette, and the
  follow-up composer with a pending permission or question docked into it. Its items live
  in `stores/thread.ts`, fed only by that thread's `ThreadService.Watch` (snapshot, then
  seq-ordered events, batched per frame); the EventService `thread` source only carries
  pending requests. Sending, interrupting (the composer's button only; no keybinding),
  answering (`thread.respond`; every pending request docks, oldest first, answerable by
  click or 1/2/3) and the model / mode / effort pickers are the `thread.*` commands
  (`docs/notes/rendered-threads-2-gui.md`, `docs/notes/rendered-threads-3-interaction.md`).
  The follow-up composer's `/` card offers the running process's slash commands from the
  thread's log (Claude Code's own in a last "Claude Code" group, inserted as plain text),
  and the ListSkills scan while there are none (`docs/notes/slash-commands-2-gui.md`).
  Every fenced code block and Bash command has Copy; a shell block in Claude's reply also
  has Run in terminal, a new shell in the thread's bottom panel through `terminal.new
  --run` (the daemon types the line once the shell has printed its prompt;
  `docs/notes/code-block-actions.md`). Text selected in one of Claude's answers can be
  cited into the composer with a comment: an amber `cf-cite://` chip whose body the draft
  keeps, sent as a self-contained `[Assistant quote](cf-cite://v1/…)` link the bubble
  reads back, painted over the answer with the CSS Custom Highlight API; GUI only, no
  command (`components/thread/cite`, `docs/notes/citations.md`).
* Only the visible thread is watched and only the visible shell is attached. Switching
  threads (or bottom panel tabs) ends the old stream and opens the new one. Background
  threads cost nothing in the frontend. Watching is also how the daemon knows a thread
  is being looked at: while a thread has a Watch subscriber, finished turns count as
  seen (`docs/notes/phase2-integration.md` describes the same rule for the old Attach).
* Layout: a draggable title strip under the hidden-inset traffic lights, sidebar (Pull
  Requests and Projects entries, then a flat list of threads and nothing else: pinned
  threads, then the ones waiting on the user (prompts, then errors), finished turns and
  idle ones, newest first within each group and with no headers, scrolling on its own;
  pinned under it the collapsible footers Working, Snoozed (single-line rows with the
  time left, soonest wake first) and Archived (single-line rows with their age), each
  counting its threads; each thread row says its status in words on its second line (or
  project and branch) with a hover tooltip; a status row at its foot; see
  `docs/notes/workspaces-4-sidebar.md`, `docs/notes/thread-list.md`,
  `docs/notes/sidebar-working-section.md`, `docs/notes/archive-threads-2-sidebar.md` and
  `docs/notes/snooze-threads-2-sidebar.md`; nothing in the GUI shows whether a thread's
  Claude runs: its composer always sends, starting looks like working, a stopped thread
  reads as its status: `docs/notes/hide-connection-state.md`), content (a thread's conversation, the Pull Requests
  page, the Projects page with each project's worktrees and each workspace's members, or
  the composer; a worktree's overview is a side panel tab, not a page; a shell is never
  selected), command palette overlay. Under the content pane, a thread and the Projects
  page each have a bottom terminal panel (cmd+j, `view.bottom.toggle`; opening a thread's
  empty one starts a shell, and a panel hides when its last shell goes:
  `docs/notes/bottom-panel-autoshell.md`), the only place shells show: tabs for the shells it owns, derived from the terminal list by the owner
  labels (`thread` for a thread's, none for the Projects page's worktree shells). Every
  way to start one lands there: cmd+t and the palette's New Terminal, a thread row's New
  terminal here, the Projects page's rows, a workspace member (in a thread's side panel
  the thread owns it), the panel's own "+", a code block's Run in terminal, and `terminal new` on the CLI; the
  focusTerminal intent reveals a shell there (threads have no terminal of their own)
  (`docs/notes/bottom-panel-2-gui.md`, `docs/notes/bottom-panel-3-routing.md`). Strip and sidebar sit on one background (the sheet);
  the content is a rounded pane on it (see `docs/notes/phase3-ui-panes.md`). Each
  selection can open a side panel right of the content: a second pane with tabs whose
  bodies come from the surface registry (`src/surfaces`, `docs/notes/side-panel.md`):
  File and Diff (one file read from disk as code, rendered markdown or sandboxed HTML, or
  an image; one changed file of a worktree against its base, working tree or branch;
  opened from the worktree overview's Changes rows, the Diff tab's Open file, and path
  chips in Claude's markdown and file tool rows (`docs/notes/file-viewer-4-chips.md`), one
  tab per file; `docs/notes/file-viewer-3-tabs.md`), Pull request, whose menu starts threads about the pull
  request through `pr.ask`, `pr.explain` and `pr.fix.findings`, Workspace (a workspace
  thread's members with their git, PR and CI state, add/remove, Run in; opened by W,
  `view.panel.workspace`, the sidebar's workspace badge, the thread header and the
  Projects page), Worktree (one worktree's overview as a tab: a thread's own worktree
  by T or `view.panel.worktree`, a project or worktree row on the Projects page by Enter
  or double-click into the page's own panel, a member from the Workspace surface;
  `docs/notes/worktree-panel-tab.md`, `docs/notes/workspaces-5-panel.md`) and Linked PRs (the
  thread's linked pull requests, newest first, each opening as a PR tab; opened by L,
  `view.panel.linked-prs`, the thread header and the sidebar's PR badge;
  `docs/notes/linked-prs.md`), MCP (the thread's MCP servers, one card each
  with status, error, tools and Reconnect; opened by M and `view.panel.mcp`;
  `docs/notes/mcp-panel.md`), Agents (the thread's subagent runs, one row each in
  spawn order with status, activity or report, and stats; opened by A, `view.panel.agents`
  and the strip above the composer that shows while background runs go on;
  `docs/notes/agents-2-gui.md`; a depth-1 row, a strip name or an Agent row's Open shows
  that run read-only in the content pane in the thread's place, the thread staying
  selected on its one Watch: `thread.agent.open`, back up by Escape or
  `thread.agent.up`; `docs/notes/subagent-view.md`) and Threads (the thread's lineage from the thread list:
  the thread whose agent created it, its siblings and the threads created from it; opened
  by H, `view.panel.threads` and the header's "from …" chip;
  `docs/notes/agents-3-lineage-gui.md`; the creator resolved by its id under its current
  name, `docs/notes/lineage-by-id.md`). Every
  palette command is reachable without the mouse, and common ones also have buttons that
  invoke the same registry command. Chords are listed only in the palette and the
  Keyboard Shortcuts overlay (`docs/notes/phase3-ui-buttons.md`), plus the hint on the
  sidebar's New thread button. The native app menu's Settings…, Thread and Help items
  run commands in the window through one host event and carry no key equivalents
  (`docs/notes/onboarding-1-entry-points.md`). The help overlay's first tab is the
  getting started guide, `docs/GETTING-STARTED.md` bundled at build time (and shipped to
  threads in the `code-foundry-help` skill); keep every label and chord it names in step
  with the app (`docs/notes/onboarding-2-guide.md`).

## 9. Project and GitHub stores

* `project`: registered projects and their worktrees. Shells out to `git` for worktree
  create/list/remove and status (branch, ahead/behind, dirty, conflicts, and the
  operation in progress, read from marker files in the admin dir without another git
  command; `docs/notes/worktree-op-state.md`). Every worktree the app makes goes to
  `<config home>/worktrees/<owner>/<repo>/<branch>` (`_local/<name>` without a GitHub
  origin); no setting or request field moves it, and only worktrees under that root are
  `Managed` (cleanable; `docs/notes/drop-worktree-dir.md`). One recursive FSEvents
  stream (cgo, confined to one goroutine) over the worktree root, every project
  directory, and any worktree outside both is routed by path to debounced status,
  base, and reconcile jobs (`docs/notes/fsevents-watcher.md`). Workers write disjoint
  per-path snapshot pointers. The backstop poll and the background fetch run each
  project on a live tier (a worktree with a live thread, or a detail asked for in the
  last 10 minutes: poll and fetch every 2 min) or a slower idle tier (poll 10 min,
  fetch 15 min); threads' edit-tool results and turn ends refresh their worktree's
  status directly, through daemon glue on the thread events
  (`docs/notes/git-activity-tiers.md`). A project may be a plain folder (`Project.Git`
  false): one synthetic checkout, no git commands; the stream (or the poll) notices a
  later `git init` (`docs/notes/add-project-2-nogit.md`).
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
* Pure functions with table tests for anything with branches: stream status, layout,
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
