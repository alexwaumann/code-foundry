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
  `window-background.json` in the config home; `docs/notes/theme-engine-3-settings.md`),
  and reopens the window at its last frame fitted to the screens attached, 90% of the
  primary work area on a first launch (`window-frame.json`; `docs/notes/window-frame.md`).
  It takes file drags from the OS (`EnableFileDrop`) and hands a drop's paths and its
  target's `data-drop-id` to the page (`app:files-dropped`), and shows the open panel
  for attaching (`PickFiles`; `docs/notes/attach-drop.md`).
  It also captures the microphone for dictation: while `DictationService.Watch` says
  LISTENING it streams 16 kHz frames with `DictationService.Audio`; it starts itself as
  its own responsible process so the macOS prompt names Code Foundry, not the terminal
  (`docs/notes/dictation-3-host.md`).
  No business logic lives in the Wails host.
* **CLI** subcommands (`code-foundry thread new --project foo`, `code-foundry focus <id>`, …)
  are clients of the same daemon API. A Claude Code session running inside the app can call
  the CLI, so threads can orchestrate other threads.

Three executables from one version stamp, installed side by side as plain executables (no
`.app` bundle; managed Macs often block unsigned bundles) in `~/.code-foundry/app`:
`Code Foundry` (the Wails GUI), `code-foundry` (daemon + CLI; `~/.local/bin/code-foundry`
links to it), `code-foundry-dictate` (the dictation engine the daemon runs) and `VERSION`
(the release tag the updater reads). `code-foundry gui` starts
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
cmd/code-foundry-dictate/  the dictation engine: whisper.cpp + Silero VAD, run by the daemon
                           over stdio JSON (docs/notes/dictation-1-engine.md)
proto/codefoundry/v1/      *.proto — the API. buf-managed. Generated code is committed.
gen/go/                    generated Go (connect-go + protobuf-go)
gui/frontend/src/gen/      generated TS (protobuf-es + connect-es)
internal/
  daemon/                  bootstrap, listeners (UDS + loopback), token file, lifecycle
  presence/                whether the user is looking at the app (GUI clients' visibility
                           and focus), with ordered subscribers
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
    backdrop/              the user's backdrop images: copies named by content, selected through settings
    update/                release checks via gh (stable or tip channel), downloads and installs with the embedded installer
    workspace/             saved project sets with a managed dir for their instructions and
                           skills (docs/notes/workspaces-v2-2-workspaces.md)
    action/                per-project actions (named command lines) and their runs, in a
                           kind=action terminal or in the background with captured output
                           (docs/notes/actions-1-daemon.md)
    plugin/                plugins: discovery, consent, one actor per enabled plugin (stdio
                           JSON-RPC), plugin.<name>.* commands, Keychain secrets, surfaces,
                           predicates, events, flags, session environment (§10)
    ember/                 Ember, the resident agent: its home (SOUL.md, MEMORY.md, seed/),
                           epochs (consolidation by a one-shot claude -p, then a reseed), the
                           task board, its workers' models (docs/notes/ember-2-store.md)
    memory/                the app memory: the user's standing preferences (<home>/memory/,
                           one file per entry with provenance, and MEMORY.md), appended to
                           every thread's system prompt at spawn
    dictation/             voice dictation: the Whisper model (<home>/dictation/models,
                           resumed download, sha256-pinned), the code-foundry-dictate engine
                           process (stdio JSON), one session at a time, unload while away
                           (docs/notes/dictation-2-daemon.md)
  childproc/               a child process in its own group with owned pipes (Claude, plugins)
  dictate/                 the dictation engine's protocol, phrase segmentation and output
                           filters (pure Go); dictate/whisper is the cgo model actor
  procscan/                the user's processes by working directory (sysctl + lsof), and
                           stopping process groups: what a thread left running in its worktree
  db/                      SQLite (modernc.org/sqlite, WAL) + migrations; refuses a database
                           migrated by a newer build (db.ErrNewerSchema)
  client/                  Go client for the daemon API, used by CLI and the Wails host
  paths/                   XDG-ish paths: config dir, socket, token, db, logs, worktrees, projects
  guide/                   the agent guide and the skills' references, rendered from commands and settings
  skills/                  the Claude Code skills written for every thread at daemon start
                           (orchestrate, help, plugin), and Ember's own (ember)
  fsx/                     the home-directory boundary and directory completion
pluginsdk/                 the plugin SDK, its own module (stdlib only, Go 1.24): manifest, protocol,
                           Serve, Host, ui (view model), plugintest (§10)
plugins/                   example plugins, built by `make plugins`: hello (every protocol method),
                           minimal (the plugin skill's template, embedded by embed.go)
gui/
  main.go                  Wails v3 host (thin)
  frontend/                Vite + React 19 + TypeScript + Tailwind v4 + shadcn + Zustand
  build/                   Wails build assets; darwin Taskfile builds the bare GUI executable
scripts/                   install.sh (embedded in the binary), package.sh, release.sh,
                           next-version.sh, ghostty-vt.sh, whisper-cpp.sh
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
lands in its own thread's bottom panel (`docs/notes/actions-1-daemon.md`). The daemon puts
the directory of `CODE_FOUNDRY_BIN` (the CLI it runs as) on the PATH of everything it
starts, so a thread finds `code-foundry` by name (`docs/notes/orch-small-fixes.md`).

Both listeners serve the same handlers. The port and token are written by the daemon on
start; the Wails host reads them and injects them into the page before load.

Services (v1):

* `ThreadService`, the lifecycle — Create, Fork, List, Get, Rename, Remove (keeps a
  24 h in-memory tombstone: Get is NOT_FOUND with a `RemovedThread` detail, Wait answers
  `removed`, List adds them on `include_removed`, subscribers get a `removed` wake;
  `docs/notes/removed-thread-signal.md`), RunIn,
  Pin (the user's pin, persisted; `docs/notes/workspaces-4-sidebar.md`), Archive (close,
  remove the thread's shells, unpin, stamp `archived_at`; pin and send
  unarchive; `docs/notes/archive-threads-1-daemon.md`), Snooze (close, remove the
  thread's shells, unpin, unarchive, set `snoozed_until`; the store wakes it on the wall
  clock into NEEDS_ATTENTION "snooze ended"; `docs/notes/snooze-threads-1-daemon.md`), Watch (server stream of every thread), Wait (block until a thread settles, by default: idle or needs attention, a pending prompt included; or until it is idle, needs attention, has an error or is disconnected; `thread.wait`, `docs/notes/agents-1-wait-events.md`, `docs/notes/thread-wait-settled.md`), Label, Report and SetBudget (agent metadata: labels, a report, a spending limit whose budget stop interrupts Claude into NEEDS_ATTENTION "budget reached"; with Create's created_by and brief, `docs/notes/agents-2-metadata.md`), Subscribe, Unsubscribe and ListSubscriptions (wake subscriptions: the daemon sends a thread a wake message, a user message with origin WAKE, when a target thread settles or meets another condition, or an action run finishes; persisted, edge-triggered from the thread store's commit and again on each new pending request, 60 per subscriber per hour; `thread.new --notify`; `docs/notes/agents-4-wake.md`, `docs/notes/wake-detail.md` for what a settled wake says), StageAttachment (images and PDFs a message refers to, as bytes or an absolute path the daemon reads; `docs/notes/pdf-attachments-1-daemon.md`, `docs/notes/attach-by-path.md`).
  Close and Reconnect remain in the proto for compatibility; no command calls them: the
  daemon starts a thread's process when a message is sent and stops it once the thread
  has idled at its prompt past its prompt cache expiry
  (`docs/notes/thread-lifecycle.md`). Create takes a project set (`project_ids`), can
  copy another thread's placement (`like_thread_id`, `new_branch`; a creating thread's
  is copied the same way) and answers collision hints; Checkouts lists a thread's
  checkouts (`docs/notes/workspaces-v2-1-threads.md`); SetWorkspace sets or clears a
  thread's workspace reference (`thread.workspace`, the GUI's Save as workspace:
  `docs/notes/workspaces-v2-3-composer.md`). Create can
  make the worktrees first (`new_worktree`), reference a workspace (`workspace_id`: its
  members are the set, its folder may be the cwd), or start without a project in the
  home directory (`no_project`; `docs/notes/no-project-1-daemon.md`; the GUI's "No
  project" picker row and composer: `docs/notes/no-project-2-gui.md`), sends the first prompt as
  the thread's first user message, and carries a permission mode (never
  bypassPermissions); see `docs/notes/new-thread-composer.md` and
  `docs/notes/workspaces-v2-2-workspaces.md`. Every thread runs headless (`claude -p` over
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
  seq-ordered; an open Watch marks the thread's turns seen while a GUI window is
  visible and key, `docs/notes/alerts-foreground.md`),
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
* `ThreadService` — the primitives of the resident agent (`docs/notes/ember-1-primitives.md`).
  Reseed gives a thread a fresh Claude session with a seed: its next process starts a
  new conversation (no `--resume`) with a system prompt append and add-dirs that every
  later spawn passes, and the first message of that session starts with a prefix
  (`UserMessageItem.seed_prefix`); the items stay, `Thread.epoch` goes up, an idle
  process stops at once and a working one when its turn ends (`reseed_pending`).
  Resident threads (`Thread.kind` RESIDENT, `resident_name`) are the daemon's own agent
  threads, made only by the store's `EnsureResident`: no project, never auto-named,
  never archived, snoozed, removed or forked, left out of a filtered List unless
  `include_resident`, kept out of the user's lists by the GUI. Wake subscriptions also
  take a timer target (`target_at` once, `target_every` repeating; wall clock, persisted,
  one catch-up wake after a stop; `thread subscribe --at/--every`). Any subscription
  takes a note (`--note`, why: in a timer's wake header, every wake's JSON and the
  listings); a thread wake's JSON has the turn's `started_at` and `ran_for`
  (`docs/notes/ember-fixes-2-timers.md`).
* `EmberService` — GetStatus, ListTasks, WatchBoard (server stream: the whole board, then
  again on every change of a task, of Ember's state, of a task's worker thread or of its
  timers, and a heartbeat when quiet): Ember, the resident agent, and its task board,
  each task with its worker's derived status and report (`docs/notes/ember-2-store.md`),
  and its pending timers (`EmberBoard.timers`, followed through the thread store's
  `SubscriptionsChanged`). Read only: Ember and the CLI change the board
  with the `ember.*` commands; `ember.*` settings turn it on and pick its models. Its
  chat is its resident thread. A thread Ember or a thread below it creates without a
  model runs on `ember.worker_models` (round robin) at `ember.worker_effort`
  (`CreateThreadRequest.model_defaulted`: the CLI's settings default counts as none).
* `TerminalService` — Attach (server stream: initial screen snapshot then live output
  chunks), Write (input bytes), Resize, Detach, Kill, Remove, and Close (kill, wait for
  the exit, remove; shells only).
* `ProjectService` — Register (a git repository, or any folder as a project without git;
  "~" expands, the path must be absolute; the Add Project dialog's Local folder tab calls
  it directly, the CLI through `project add <folder>`), InspectFolder (what Register would
  make of a folder: a repository, else the git repositories directly inside it; the Add
  Project dialog asks first and offers a folder of repos as a rooted workspace through
  the `project.add-workspace` command, which registers each repository and creates the
  workspace with the folder as its root; `docs/notes/workspaces-v2-6-scan.md`),
  Unregister, List, ListWorktrees, CreateWorktree (optionally fetching the base first),
  DeleteBranch (a branch no worktree has checked out, `-d` unless forced, origin's on
  request; `docs/notes/orch-cli-batch.md`), CleanupWorktrees (remove worktrees whose work is in origin/<default>: `merged_clean`,
  no thread (archived ones aside; any of its checkouts) or terminal on it; never deletes branches;
  each removed or kept worktree comes with its reason, which the confirmation lists;
  `force` also removes those kept only for uncommitted changes, which are marked so
  the command can ask first; a removal refused for uncommitted changes, here or in
  RemoveWorktree, carries an `UncommittedWork` detail; each worktree also carries `managed`,
  `landed` and its `cleanup_reason`, which the Projects page's "Worktrees without threads"
  reads instead of re-deriving git rules;
  `docs/notes/projects-polish-3.md`, `docs/notes/cleanup-eligibility.md`,
  `docs/notes/projects-redesign-2-leftovers.md`),
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
  A command that asks first fails Invoke with a `ConfirmationRequired` detail; clients ask
  and invoke again with `confirmed`. A confirmed command may ask a second time with
  `args` to merge (removing a worktree would delete uncommitted work: `force`) and
  optionally the result that stands if the user declines; the GUI asks again, the CLI
  prompts again on a terminal, and `--yes` never answers it
  (`docs/notes/dirty-worktree-confirm.md`).
* `UiService` — WatchIntents (server stream: focus thread, open palette, …); Emit (from
  CLI). A ShowView with a `thread_id` (the `view.panel.*` verbs run inside a thread)
  changes only that thread's side panel and never a window's selection; `ui.presence`
  tells a thread's model whether the user is looking and whether a window shows its
  thread (`docs/notes/control-1-thread-scoped-views.md`). A Notify may carry a `link`
  ("settings:<page>"), a button on the toast (`docs/notes/memory-page.md`).
* `EventService` — Watch: one server stream that multiplexes every store's events and UI
  intents (sources project, workspace, terminal, thread list, thread, gh, gitops, settings,
  update, action, plugin, skill, memory, ui; the thread source carries threads' pending requests only, a
  snapshot then changes, never items; filterable). On connect it sends each source's snapshot in that order, then live events; a source that drops events for a
  slow client resends only its own snapshot. This is the GUI's only long-lived sync
  stream; the per-service Watch RPCs remain for the CLI and tests. Live events pass
  through one hub that numbers them (`Event.seq`, one daemon-wide sequence) and keeps
  the last 4096; `since_seq` resumes a stream without snapshots while they cover it
  (`code-foundry events --since`; `docs/notes/agents-1-wait-events.md`). Every event
  carries the daemon's `epoch` (drawn at startup); a `since_epoch` of another daemon
  starts over with snapshots (`docs/notes/agents-5-cli.md`). The GUI opens it as
  `client_kind` GUI with a per-stream `client_id`, its visibility and focus, and updates
  them with SetClientState. The registry of GUI clients writes the daemon's presence
  (`internal/presence`: none, background or foreground, and attended when a window is
  visible and key), which any store can read and subscribe to: its kind paces the
  GitHub poll (`docs/notes/gh-poll-tiers.md`), attended decides whether an open thread
  view counts as seen (`docs/notes/alerts-foreground.md`).
* `SettingsService` — GetSchema, Get, Update, Watch over `$CONFIG/settings.toml` (TOML,
  hand-editable, reloaded on change). See `docs/notes/phase3b-settings.md`. ListBackdrops,
  ImportBackdrop, RemoveBackdrop and ReadBackdrop keep the user's backdrop images (copies in
  `$CONFIG/backdrops`, internal/store/backdrop) that `appearance.backdrop = custom` shows
  (`docs/notes/custom-backdrop.md`); Update refuses `custom` unless `appearance.backdrop_file`
  names one of them (`docs/notes/backdrop-custom-guard.md`).
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
* `WorkspaceService` — List, Create, AddProject, RemoveProject, Rename, SetDefaultPrimary,
  SetRoot, Remove, Watch. A workspace is a saved set of projects (`members`, sorted ids), a
  `default_primary` (a member or `workspace`; a project named "workspace" wins over the
  keyword), an optional `root_path` (under home, never home itself nor inside a
  registered project; `root_missing` when it moved, which SetRoot repairs) and a managed
  dir, `<config home>/workspaces/<id>` (0700, repaired at start): a synthetic workspace
  keeps its CLAUDE.md, AGENTS.md and `.claude/skills` there; a rooted one holds links to
  its root's, re-checked at every spawn, and its files are read from the root itself.
  Names are NFC and never look like an id. The daemon drops unregistered projects from
  every workspace and refuses removing a synthetic one while a thread that is not
  archived runs in its managed dir; Watch reads every folder again on subscribe. No
  branch, no worktrees. See `docs/notes/workspaces-v2-2-workspaces.md` and
  `docs/notes/workspaces-v2-fix-1-workspace.md`. The GUI gets workspaces from
  EventService's `workspace` source (a `workspaces` slice).
* `FilesystemService` — ListDirectories: completes a typed path prefix to directories
  under the user's home (is_git, registered, common completion), for the palette's
  `path` prompts and the Add Project dialog's Local folder tab. Every project path must resolve under home; `project.Register` enforces
  it too (`docs/notes/add-project-1-paths.md`). ListSkills (`.claude/skills` and
  `.claude/commands` of given checkouts, plus the user's) and SearchFiles (fuzzy match over
  a checkout's git-listed or walked files, cached ~5s) feed the composer's `/` and `@`
  completion (`docs/notes/composer-tags-1-daemon.md`; the GUI's tags and `/` card:
  `docs/notes/composer-tags-3-skills.md`; the `@` card: `docs/notes/composer-tags-4-files.md`).
* `ActionService` — List, Create, Update, Delete, Run, GetRun, WaitRun, StopRun, Watch. Per-project
  actions (name unique per project ignoring case, command, icon, in terminal or in the
  background, run on worktree create, position; SQLite, cascading with the project) and
  their runs (in memory, 50 per project). A run belongs to a thread or a worktree like a
  shell, runs `$SHELL -lc <command>` there with `CODE_FOUNDRY_PROJECT_ROOT` and
  `CODE_FOUNDRY_WORKTREE`, in a `kind=action` terminal or as a background process whose
  last 64 KiB of output WaitRun returns; StopRun ends one (`action.stop`, and an
  interrupted `action run --wait` of a background run). A new thread's worktree runs the
  project's on-worktree-create actions in the background, one after another, each stopped
  after 10 minutes; `run_finished` events carry every end
  (`docs/notes/actions-1-daemon.md`). The action.* commands are the CLI's surface.
* `PluginService` — List, Enable (with consent, else the text to consent to), Disable,
  Restart, Dev (link a folder and enable it), Reload, Logs, FollowLogs, ListSecrets,
  DeleteSecret, Watch. Plugins are executables in `$CONFIG/plugins/<name>` the daemon runs
  and speaks newline-delimited JSON-RPC 2.0 with over stdio; their manifest commands are
  `plugin.<name>.<command>` (§10; `docs/notes/plugins-1-core.md`; design in
  `docs/sketches/plugins/`).
  WatchSurface, GetSurface and Act serve plugin surfaces: views (the `pluginsdk/ui`
  JSON the daemon validates) per instance `<plugin>/<surface>/<scope>`, opened on the
  first watcher; each surface's `plugin.<name>.show.<surface>` command carries its
  availability (a when clause over host facts) in CommandService.List
  (`docs/notes/plugins-2-surfaces.md`).
  Environment returns what plugins add to new threads
  (`session/setEnvironment`: env, PATH entries, `--add-dir`s, scoped by project; `plugin
  env`). Plugins subscribe to EventService's sources over the protocol (`events/subscribe`,
  `api.PluginFeed` on the same loop as Watch, a bounded drop-oldest queue per plugin) and
  raise flags on threads (`thread/setFlag`; `Thread.flags`, ThreadService.ClearFlags,
  `thread flags`); `docs/notes/plugins-3-events-flags-env.md`.
* `SkillService` — Search, Installed, Registries, Watch (the epoch): the Skills
  marketplace, read only; its actions are the `skill.*` commands (§10;
  `docs/notes/skills-3-api.md`).
* `MemoryService` — Get, Watch (the whole memory with provenance and caps): the app
  memory, read only; its actions are the `memory.*` commands (`docs/notes/memory-dir.md`).
  The GUI shows it on Settings › Memory, fed by the EventService memory source
  (`docs/notes/memory-page.md`).
* `DictationService` — Watch (the whole state: on/off, model and download, this Mac,
  the open session, mic denied), Download, CancelDownload, RemoveModel, Start, Stop,
  Session (one session's levels, phrases and end), Audio (the Wails host's microphone
  client stream), MicDenied: voice dictation into the composers, transcribed on this Mac
  by the code-foundry-dictate engine the daemon runs (`docs/notes/dictation-2-daemon.md`).
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
  for a future program that wants them. `ScrollbackText` (scrollback + screen as plain
  text, from the emulator) serves plugin `terminal/read` with `scrollback`.
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
* A thread has a **project set** (`project_ids`, sorted by id; persisted as a JSON column)
  and one **primary** (`project_id`/`worktree_path`: the cwd); a thread without a project
  has an empty set, runs in the home directory (`Options.Home`), pre-trusted like any cwd,
  and RunIn refuses it (`docs/notes/no-project-1-daemon.md`). The thread owns one
  **checkout** per member, by path (`checkout_paths`, the `checkouts` JSON column; the
  primary's is the cwd), and what a checkout has checked out (HEAD, detached, upstream
  ahead/behind, the operation in progress) is read from the project snapshot at that
  path, never from the row, so a checkout whose branch moved (`git switch`, a stacked
  branch) is the same checkout (`checkouts.go`, `docs/notes/thread-checkouts.md`).
  `branch` is the branch a worktree-mode thread was created for, a record: a checkout on
  another one is `moved`, and recreate checks it out again unless the cleanup that
  removed the worktree recorded another HEAD (`last_heads`). Create records the
  paths by the creation rule: in worktree mode (`created_worktree`) a git member's
  worktree made for the branch at the project store's `DefaultWorktreePath`, or one that
  exists for it (that path while it has the branch checked out, or a hand-made linked
  worktree on the branch; never the project's main checkout: while it has the branch
  checked out, making the thread's worktree is refused, naming the project, the branch and
  the checkout, since a second worktree on one branch makes a commit in one look reverted
  in the other; nor a worktree at that path switched to another branch, another thread's
  checkout now: refused too, naming its HEAD and thread); a plain folder is the folder; in
  checkout mode each member's own checkout. A member with none recorded (a row from
  before, filled at daemon start from that rule; a worktree missing then) is resolved by
  the same rule and recorded at its next start; a recorded checkout-mode one that is gone
  falls back to the member's own checkout, with a timeline note. Collision hints compare
  paths.
  `thread new` places a thread (`placement.go`): `--projects` gives the set,
  `--new-worktree` makes one new branch in every git member (in parallel, fetch first,
  pre-trusted, recorded as made; one failure removes what the others got and fails the
  Create naming the project; a named `--branch` only on origin is fetched and tracked;
  Creates at the same time share a named branch's worktrees under the per-(project,
  branch) lock and reserve an auto-named one, so the second gets `-2`), `--like` copies
  another thread's set, branch, primary, workspace reference, mode and checkouts (the
  same paths, whatever they have checked out; `--workspace` with it replaces only the
  reference), and a thread made by another (`created_by`) copies its
  creator's the same way unless `--project`/`--worktree` name a place outside its set
  (`--created-by=` opts out of both). A narrowed `--projects` with no git project drops
  worktree mode. Create reports what it did with the primary (`CreateThreadResponse`
  `made_worktree`, `existing_worktree`/`shared_with`, `worktree_mode_dropped`) for the
  CLI's summary (`docs/notes/workspaces-v2-fix-2-threads.md`).
  Every spawn (create, a start on send, fork) first makes missing worktree-mode worktrees
  again on the created-for branch and records unrecorded members (`ensureMembers`, beside
  `recreate.go`'s for the primary) and gives Claude `--add-dir` for every other member's
  checkout; a missing one is a spawn error. `workspace_id` is an
  optional reference to a workspace (`thread new --workspace`: its members are the set
  unless `--projects`, its default primary the cwd, `workspace` its folder): every spawn
  re-checks its managed dir, passes it as an `--add-dir` (not when the thread runs in it
  or the root) and appends its CLAUDE.md (else AGENTS.md, at most 32 KiB, read from the
  root of a rooted one) under "Workspace <name> instructions", unless the thread runs in
  the managed dir, the root or a folder inside the root, where Claude loads them itself
  (a rooted workspace whose root moved adds nothing; a spawn whose cwd is gone fails
  naming it, a workspace's managed dir is made again); that block follows the
  static line every thread gets pointing at the skills below and sending split-up,
  parallel or multi-branch work to the orchestrate skill rather than the Agent tool
  (`ThreadPrompt`; `docs/notes/agents-5-cli.md`, `docs/notes/agent-skills.md`,
  `docs/notes/orch-skill-v2.md`, `docs/notes/workspaces-v2-2-workspaces.md`). `ThreadService.Checkouts` (`thread checkouts`) lists a
  thread's checkouts; Create answers collision hints (a checkout another live thread has)
  that the CLI prints on stderr. An archive hands the thread to the daemon
  (`Options.Archived`), which removes each worktree-mode worktree the app made that is clean
  and that no other thread or terminal holds (`project.ArchivedVerdict`,
  `internal/daemon/cleanup_archived.go`; cleanups of one path run one at a time), never
  its branch (`docs/notes/workspaces-v2-1-threads.md`). A removal does the same with the
  removed thread (`Options.Removed`, after its row and tombstone; the abandoned sweep stays
  the backstop; `docs/notes/remove-cleans-worktrees.md`). Unregistering a project runs the
  same verdict first over every worktree the app made for it
  (`api.Project.WithBeforeUnregister`); a member whose project is no longer registered is
  left out of a start with one timeline note.
* **Skills**: at every start the daemon writes four Claude Code skills, `code-foundry`
  (the entry skill: what the app is, the one rule, which skill to read, and
  `daemon.capabilities` for what exists now; `docs/notes/control-4-capabilities.md`),
  `code-foundry-orchestrate` (delegating work to other threads), `code-foundry-help`
  (how-to questions about the app) and `code-foundry-plugin` (building plugins, §10), to
  `<config home>/claude/.claude/skills` (`internal/skills`: static SKILL.md files
  embedded, references rendered from the registry and the settings schema through
  `internal/guide`, `docs/GETTING-STARTED.md` embedded by the `docs` package). Every spawn passes `<config home>/claude` as its first
  `--add-dir`, before the attachments dir, a workspace's managed dir, the other members' checkouts and grants
  (`docs/notes/agent-skills.md`). The entry skill's Scopes say where a standing rule goes:
  the app memory (every project), the workspace's folder that `thread checkouts` prints
  (`CLAUDE.md`, `.claude/skills/<name>/SKILL.md`: a set of projects; `ThreadPrompt` says
  so too) or a repo's own `CLAUDE.md`, and that a member's `CLAUDE.md` is read before
  editing there (only the primary's loads); the orchestrate skill's children inherit
  the creator's projects, workspace, branch and mode, narrowed per worker with
  `--projects` (`docs/notes/workspaces-v2-5-skills.md`). Every skill file carries a
  provenance line under its title (`version.Info.Provenance`: the build, and its source on GitHub at the release
  tag or commit), and the help skill sends internals questions to that source
  (`docs/notes/control-2-skill-provenance.md`).
* **App memory** (`internal/store/memory`): the user's standing preferences about the app
  and the model inside it, in `<config home>/memory/`: one markdown file per entry (its
  provenance in frontmatter: created, the thread that added it and its name then) and an
  index, `MEMORY.md`, written and never read (at most 40 entries, 4 KiB injected), written
  only by the daemon through `memory.*`. Every spawn reads the entries (`Options.Memory`) and, when there are any, appends
  them under one heading after the `ThreadPrompt` line and a workspace's instructions, before a thread's
  own append (`docs/notes/control-3-app-memory.md`, `docs/notes/memory-dir.md`).
* **Spawn extras** (`spawnextras.go`): what plugins contribute to every spawn through the
  same `claudeCommand` path, read from the plugin store by a function the daemon sets
  (`SetSpawnExtras`): their `--add-dir`s right after the skills dir (then attachments,
  the managed dir, the other members' checkouts, grants), their env after the daemon's, their PATH
  entries in front of PATH. A spawn may wait up to 2 s for a plugin still starting; the
  effort restart never waits and re-reads them. Naming and shells get none
  (`docs/notes/plugins-3-events-flags-env.md`).
* **Flags** (`flags.go`): plugins' attention / error flags with a one-line reason, one per
  (thread, plugin), an overlay that never touches status; persisted (`thread_flags`),
  cleared by the plugin, when it is disabled or removed, on archive, and for until-seen
  flags when the thread's items are watched. The GUI counts a flagged thread as needing
  attention (sort group, line 2, window title, dock).
  `ThreadService.RunIn` moves a thread to another of its checkouts (that member becomes
  the primary) with the control protocol's `set_cwd` once it is idle (`docs/notes/workspaces-2-launch.md`, superseded
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
  a cleanup removed makes it again first, at the same path, so `--resume` finds the
  transcript, on the branch it had when removed (recorded by the cleanup, while that
  branch exists) else the created-for one, and the thread's other worktree-mode worktrees
  too; user checkouts keep the refusal (`recreate.go`, `docs/notes/recreate-worktree.md`,
  `docs/notes/recreate-last-head.md`).
  A conversation whose transcript Claude Code deleted (its `cleanupPeriodDays`) cannot
  continue: the start is refused (`ErrTranscriptMissing`, FAILED_PRECONDITION, nothing
  written; Send, Reconnect, Fork and the MCP and slash command queries alike) and
  `Thread.transcript_missing` says so, checked at daemon start, when a process ends and on
  a refusal, never per snapshot; a reseed is the one way to start over, and a resident
  thread starts a new conversation as before (`transcriptmissing.go`,
  `docs/notes/transcript-deleted.md`).
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
  ("Fix the login redirect") and, for a new worktree or workspace, its branch in the same
  call, in the `projects.branch_naming` mode: `semantic` (default, `<type>/<slug>`, the
  type validated against feat, fix, chore, docs, ci, refactor, test, perf, build),
  `prefix` (`<prefix>/<slug>`) or `custom` (the model follows
  `projects.branch_instructions`; git checks the result). `thread new --branch` with a
  slash is the branch, without one the slug; an existing one is checked out. Taken
  generated branches get `-2`..`-9`; anything unusable is `cf/<thread id>`
  (`branchname.go`, `docs/notes/natural-thread-names.md`,
  `docs/notes/branch-naming-modes.md`). Until it answers, a thread with a first prompt
  has a provisional name, the prompt's first line or sentence cut to 48 characters
  (`name_provisional`, `provisional.go`); the title replaces it, a rename clears it, the
  branch never uses it (`docs/notes/provisional-names.md`). Once a thread whose worktree Create made has
  started, `Options.WorktreeCreated` hands the worktree to the daemon, which runs the
  project's on-worktree-create actions in the background (the thread store does not
  know about actions; `docs/notes/actions-1-daemon.md`).
* **Linked pull requests** come from Claude's own `pr-link` transcript records: every
  distinct URL in first-seen order, persisted in `thread_pull_requests`, backfilled from
  the transcript's history when a thread is resumed (`docs/notes/linked-prs.md`). A
  thread also has every link of the threads it created (`CreatedBy`, transitively, not
  forks): each new link is copied up the chain with its source and the direct child it
  came through (`docs/notes/linked-prs-children.md`). And it has every pull request whose
  head is a branch it works on (each of its checkouts' HEAD) in the
  project's GitHub repository: the daemon matches them against the GitHub store's cached
  lists (dashboards and branch lists, no new polling) and pushes them to the thread
  store as `branch` links (`docs/notes/linked-prs-branch.md`).
* **Hidden children** (`sidebar.go`): a thread another thread created is its creator's to
  manage and is not shown in the sidebar unless the `threads.show_created_threads`
  setting (live, `SetShowCreatedThreads`) or its own persisted override
  (`Thread.in_sidebar`: `SetSidebar`, `thread new --sidebar`) shows it; `InSidebar` is
  the one rule, which the GUI reimplements. Archiving a thread first archives the hidden
  threads below it, through hidden ones only (`ArchiveCascade`, the `descendants-of`
  walk), and `ThreadFilter.archive_cascade_of` lists them for the command's
  confirmation (`docs/notes/hidden-children-1-daemon.md`).
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
* **Processes** a thread leaves behind: Claude runs in its own process group, which the
  runner signals as the last step of every end of the process (after the graceful close
  or a crash). Claude Code puts each Bash call in a group of its own, so Archive and
  Remove also look for the orphans (parent launchd) whose working directory is in the
  thread's cwd and that started after the thread was made. They stop those orphans'
  process groups only when the cwd is a worktree Code Foundry made (under
  `Options.WorktreeRoot`); in a project's own checkout they only log them. Never for a
  cwd that is home or above it or that another live thread shares, never an app bundle
  (`strays.go`, `internal/procscan`, `docs/notes/ember-fixes-2-small.md`).
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
view, and the workspace the active thread or composer references (`thread.run-in` is
offered for any thread, the daemon refusing one with no other checkout; the `thread.*` commands,
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
`thread.wait --after` wait for the turn after a message, and a plain `thread.wait` for
the turn after the thread's latest message (`docs/notes/send-ordinal-wait-after.md`). `code-foundry guide` (a local
verb, like `--help`) prints a Markdown guide for agents generated from `CommandService.List`
(`internal/guide`, which also renders the skills' command references): the conventions and
the Thread commands, and a topic per other category that `code-foundry guide <topic>`
prints (`docs/notes/hidden-children-1-daemon.md`).

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
* Connection budget: the GUI holds exactly one `EventService.Watch` stream plus one
  `ThreadService.Watch` per visible thread view (the content pane's thread, a plugin's
  thread node; one stream when both show the same thread) and one `TerminalService.Attach`
  per visible terminal view (the bottom panel's active shell, a plugin's terminal node),
  each only while it is visible: usually two, three or four with a plugin's thread or
  terminal on screen. Everything else is unary, except a
  `ProjectService.Clone` stream while the Add Project dialog clones a repository. This keeps
  the browser's six HTTP/1.1 connections per origin mostly free.
* Dictation (`stores/dictation.ts`, `docs/notes/dictation-4-gui.md`): one shared
  `DictationService.Watch` only while `dictation.enabled` is on (composers hold it at
  "inline" priority) or the settings section is on screen ("core"), and one
  `DictationService.Session` while a composer dictates. A phrase lands at the caret of the
  composer that pressed the mic (every composer: thread, new thread, Ember, the PR panel's
  ask and review), tinted by a ProseMirror decoration, never a mark.
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
* Only visible views are watched or attached: one Watch per thread on screen
  (`stores/thread.ts` `startThreadWatch` counts its holders), one Attach per terminal
  view (a plugin terminal shown in the bottom panel is not attached in its node too).
  Switching threads (or bottom panel tabs) ends the old stream and opens the new one. Background
  threads cost nothing in the frontend. Watching is also how the daemon knows a thread
  is being looked at: while a thread has a Watch subscriber, finished turns count as
  seen (`docs/notes/phase2-integration.md` describes the same rule for the old Attach).
* Layout: a draggable title strip under the hidden-inset traffic lights, sidebar (Pull
  Requests and Projects entries, then a flat list of threads and nothing else: pinned
  threads (newest created first), then the ones waiting on the user (prompts, then
  errors) and finished turns (most recent status change first), and idle ones (most
  recent activity first), with no headers, scrolling on its own;
  pinned under it the collapsible footers Working, Snoozed (single-line rows with the
  time left, soonest wake first) and Archived (single-line rows with their age), each
  counting its threads; each thread row says its status in words on its second line (or
  project and branch; a thread of several projects names its workspace, else "N
  projects", and its branch: `docs/notes/workspaces-v2-3-composer.md`) with a hover
  tooltip; a status row at its foot; see
  `docs/notes/workspaces-4-sidebar.md`, `docs/notes/thread-list.md`,
  `docs/notes/sidebar-working-section.md`, `docs/notes/archive-threads-2-sidebar.md` and
  `docs/notes/snooze-threads-2-sidebar.md`; a thread another thread created is hidden
  from every sidebar list, the keyboard order and the attention counts unless
  `threads.show_created_threads` or its own override shows it, one rule in
  `lib/inSidebar.ts`, and a hidden selected thread highlights its nearest shown
  ancestor: `docs/notes/hidden-children-2-gui.md`; nothing in the GUI shows whether a thread's
  Claude runs: its composer always sends, starting looks like working, a stopped thread
  reads as its status: `docs/notes/hide-connection-state.md`), content (a thread's conversation, the Pull Requests
  page, the Projects view: an index of projects and workspaces by last activity that
  drills into a project's page (its checkouts table and details) or a workspace's page,
  each its own selection with its own side panel, the sidebar row reopening the last one
  (`docs/notes/projects-redesign-1-index.md`); a workspace's page: its projects with
  where new threads start (Start here, Remove, Add project), its threads with each
  member's checkout for the thread's branch, its instructions file (View as a File tab,
  Write/Edit instructions starting or steering a thread in the workspace's folder), skills
  and folder, Open in Finder, Rename (in place) and Remove; a New workspace dialog:
  `docs/notes/workspaces-v2-4-projects-page.md`, `docs/notes/projects-redesign-3-workspace-page.md`), or the composer: a project set
  picked in the heading (a workspace row selects its members and the reference, projects
  toggle), chips by project id, Work in, a Runs in picker for the primary (a project or
  the workspace's folder), collision hints under the chips, and "New thread on this
  branch" (`thread.new-like`) prefilled from a thread so only the prompt is typed:
  `docs/notes/workspaces-v2-3-composer.md`; a worktree's overview is a side panel tab, not
  a page; a shell is never selected), command palette overlay. Under the content pane, a thread and the Projects
  page each have a bottom terminal panel (cmd+j, `view.bottom.toggle`; opening a thread's
  empty one starts a shell, and a panel hides when its last shell goes:
  `docs/notes/bottom-panel-autoshell.md`), the only place shells show: tabs for the shells it owns, derived from the terminal list by the owner
  labels (`thread` for a thread's, none for the Projects page's worktree shells). Every
  way to start one lands there: cmd+t and the palette's New Terminal, a thread row's New
  terminal here, the Projects page's rows, the panel's own "+", a code block's Run in terminal, and `terminal new` on the CLI; the
  focusTerminal intent reveals a shell there (threads have no terminal of their own)
  (`docs/notes/bottom-panel-2-gui.md`, `docs/notes/bottom-panel-3-routing.md`). Strip and sidebar sit on one background (the sheet);
  the content is a rounded pane on it (see `docs/notes/phase3-ui-panes.md`). Each
  selection can open a side panel right of the content: a second pane with tabs whose
  bodies come from the surface registry (`src/surfaces`, `docs/notes/side-panel.md`):
  File and Diff (one file read from disk as code, rendered markdown or live HTML in a
  sandboxed frame served by the daemon's `/preview/<grant>/` route (`internal/preview`,
  `docs/notes/html-preview-interactive.md`), or
  an image; one changed file of a worktree against its base, working tree or branch;
  opened from the Changes tab's rows, the Diff tab's Open file, and path
  chips in Claude's markdown and file tool rows (`docs/notes/file-viewer-4-chips.md`), one
  tab per file; `docs/notes/file-viewer-3-tabs.md`), Pull request, whose menu starts threads about the pull
  request through `pr.ask`, `pr.explain` and `pr.fix.findings`, Changes (kind `changes`:
  one worktree's changed files and commits against its base, each file opening its Diff
  tab; opened from the thread info card's Changes row and per-project sub-rows, and from
  a project page's checkout rows into the page's own panel;
  `docs/notes/thread-header-crumb.md`) and MCP (the thread's MCP servers, one card each
  with status, error, tools and Reconnect; opened by the card's MCP row and
  `view.panel.mcp`; `docs/notes/mcp-panel.md`). The Worktree, Workspace, Linked PRs,
  Usage, Agents and Threads surfaces and their `view.panel.*` verbs are gone: the thread
  info card shows what they did (`docs/notes/thread-info-card.md`). A depth-1 subagent row
  or a strip name above the composer (background runs) shows that run read-only in the
  content pane in the thread's place, the thread staying selected on its one Watch:
  `thread.agent.open`, back up by Escape or `thread.agent.up`;
  `docs/notes/subagent-view.md`. Every
  palette command is reachable without the mouse, and common ones also have buttons that
  invoke the same registry command. The palette lists the commands the daemon does not
  mark `NoPalette` (`Command.no_palette`): queries whose only output is a text toast,
  verbs for the model or the CLI to drive the app, Ember's task board, and verbs whose
  required arg is an opaque id a page offers on the right row;
  `internal/command/palette_test.go` keeps that list (`docs/notes/palette-no-palette.md`). Chords are listed only in the palette and the
  Keyboard Shortcuts overlay (`docs/notes/phase3-ui-buttons.md`), plus the hint on the
  sidebar's New thread button. The native app menu's Settings…, Thread and Help items
  run commands in the window through one host event and carry no key equivalents
  (`docs/notes/onboarding-1-entry-points.md`). The help overlay's first tab is the
  getting started guide, `docs/GETTING-STARTED.md` bundled at build time (and shipped to
  threads in the `code-foundry-help` skill); keep every label and chord it names in step
  with the app (`docs/notes/onboarding-2-guide.md`).
* Ember in the GUI (`docs/notes/ember-3-gui.md`): while `ember.enabled` is on and the
  resident thread exists, a pinned row above New thread (the flame glyph,
  `components/ember/Flame.tsx`, in its idle, thinking, working or attention state; "Ember"
  and a status line; the thread list's arrows reach it) opens Ember's chat in the content
  pane. The chat is the resident thread's own Watch and timeline list (ThreadPane routes a
  resident `ember` thread to `components/ember/EmberPane.tsx`) with its own rows
  (`lib/ember.ts` `buildEmberRows`): the user's messages and Ember's text show, and every
  run of work between them (tool calls, subagents, wakes) folds into one "Worked for" row;
  task links (`[Title](cf-task://t-…)`) render as pointer lines that open the Board
  surface (`surfaces/ember.ts`, Ember's panel only) at the task. One shared
  `EmberService.WatchBoard` (`stores/ember.ts`) feeds the row, the chat header and the
  Board while any of them shows (inline for the row alone, core with the chat or the
  Board). cmd+shift+a visits Ember's attention first; the window title, the Dock badge
  and lists leave it out.
* Skills page (`docs/notes/skills-4-gui.md`): Settings → Skills is a GUI page
  (`components/settings/guiPages.ts`, `components/skill/settings`) over `stores/skill.ts`,
  held open (`openSkillMarketplace`) while it shows. Installed rows (plugins and skills,
  "from <marketplace>" or Local, Enabled / Disabled / Needs setup / Missing) carry the
  actions `installedActions` gives; Browse is the daemon's search (150 ms debounce, tier
  and kind chips, at most 200 hits in a `VirtualStack` on the page's scroll box);
  Registries lists Claude Code's marketplaces or says how to add one. Disable, Uninstall
  and Remove confirm in the page's dialog and answer the daemon's confirm for that call
  (`stores/skillConfirm.ts`, as `plugin.uninstall` does). A GUI-only page lists its
  sections in its `SettingPageView`, and the settings search finds them by name
  (`searchGuiPages`): a hit opens the page at the section.

## 9. Project and GitHub stores

* `project`: registered projects and their worktrees. Shells out to `git` for worktree
  create/list/remove and status (branch, ahead/behind, dirty, conflicts, and the
  operation in progress, read from marker files in the admin dir without another git
  command; `docs/notes/worktree-op-state.md`). Every worktree the app makes goes to
  `<config home>/worktrees/<owner>/<repo>/<branch>` (`_local/<name>` without a GitHub
  origin); no setting or request field moves it (`docs/notes/drop-worktree-dir.md`).
  CreateWorktree resolves the new branch's start point in one place
  (`startpoint.go`): with `projects.base_from_origin` (every daemon caller passes it)
  no base or a bare branch name is origin's copy when origin has it, fetched first,
  unless the local branch is ahead of it (or diverged), then the local branch; off,
  the local default and the base as typed, no fetch (`docs/notes/base-from-origin.md`,
  `docs/notes/base-origin-rule.md`). CreateWorktree records each worktree it makes (`project_worktrees`: path, HEAD, time),
  and only a recorded one is `Managed` (cleanable); a `git worktree add` under the root
  is not. Cleanup keeps one made in the last 10 minutes with no commit since, and counts
  a branch whose rebased or squash-merged copy landed as merged (`Status.BaseMerged`, a
  memoized `git merge-tree`; `docs/notes/cleanup-eligibility.md`). One recursive FSEvents
  stream (cgo, confined to one goroutine) over the worktree root, every project
  directory, and any worktree outside both is routed by path to debounced status,
  base, and reconcile jobs (`docs/notes/fsevents-watcher.md`); a live worktree's tree
  edits also feed a files job that publishes the changed, non-ignored paths once per
  tree window (`WorktreeFilesChanged`, not in the snapshot;
  `docs/notes/gh-events-2-worktree-files.md`). Workers write disjoint
  per-path snapshot pointers. The backstop poll and the background fetch run each
  project on a live tier (a worktree with a live thread, or a detail asked for in the
  last 10 minutes: poll and fetch every 2 min) or a slower idle tier (poll 10 min,
  fetch 15 min); threads' edit-tool results and turn ends refresh their worktree's
  status directly, through daemon glue on the thread events
  (`docs/notes/git-activity-tiers.md`). After a live project's fetch, checkouts on
  its default branch that are only behind their upstream and not busy are
  fast-forwarded through gitops (`projects.auto_pull`; busy is daemon glue over the
  thread, action and gitops snapshots; `docs/notes/auto-pull.md`). A project may be a plain folder (`Project.Git`
  false): one synthetic checkout, no git commands; the stream (or the poll) notices a
  later `git init` (`docs/notes/add-project-2-nogit.md`).
* `gh`: GitHub GraphQL (and a little REST) sent in-process over one keep-alive HTTP
  client with the token from `gh auth token` (github.com only; see
  `docs/notes/gh-http-transport.md`). Scoped to the viewer: their PRs (authored, review
  requested, reviewed, recently merged), tracked repositories' default-branch CI, and
  their PRs on watched branches. One fingerprint request per poll interval; details only
  for what changed (`docs/notes/gh-viewer-polling.md`). Results cached in SQLite so
  startup is instant and offline is tolerable.

## 10. Plugins

Plugins extend the app without changing it: separate executables, written by users and
mostly by agents, that the daemon runs and that contribute commands, side-panel
surfaces, thread flags, a share of every new thread's environment, and Claude threads and
terminals of their own. Design: `docs/sketches/plugins/` (`DECISIONS.md` wins); what was
built: `docs/notes/plugins-1-core.md` through `plugins-6-thread-terminal.md`.

* **Package.** A folder `$CONFIG/plugins/<name>` with a `plugin.json` (name, version,
  protocol, `exec`, permissions, commands, surfaces) and the executable. `plugin dev`
  links a folder there; registry installs (PR 7) unpack a release tarball there. A
  plugin found on disk is disabled until the user consents to its permissions
  (`commands` globs, `events` sources, `threadStatus`, `sessionEnv`, `secrets`,
  `threads`, `terminals`, `api`: the registry entry's keys); more permissions on an
  update disable it again until they consent.
* **Store** (`internal/store/plugin`): discovery and the `plugins` table, one actor per
  enabled plugin (start with cwd = package folder and a minimal env, `initialize`
  within 5 s, ping every 30 s, backoff 1 s to 60 s, failed after 5 crashes in 10 min,
  dev plugins never fail), logs (`logs/plugins/<name>.log` plus a 1,000-line tail), the
  Keychain secrets (`security`, service `code-foundry-plugin`). Plugin → host methods
  are a registry (`hostMethods`) each feature file fills from `init`. The store never
  imports the thread or gh stores: the daemon adapts them (`plugin_hooks.go`,
  `pluginfacts.go`).
* **Protocol.** Newline-delimited JSON-RPC 2.0 over the plugin's stdio, proxy-only (no
  token unless `api`). Host → plugin: `initialize`, `initialized`, `ping`, `shutdown`,
  `command/invoke`, `surface/open|visibility|close|act`, `events/event`. Plugin → host:
  `log`, `host/invoke` (the manifest's command globs; never a confirm on the user's
  behalf; `confirm: ask` hands it to the GUI), `secret/*`, `view/update|append|toast`,
  `context/set`, `thread/setFlag`, `events/subscribe`, `session/setEnvironment`,
  `thread/create|send|archive|list`, `terminal/create|close|list`. A `surface/act`
  carries the acting panel's context.
* **Commands.** Manifest commands are `plugin.<name>.<command>` in the one registry
  (`Registry.ReplacePrefix` on enable and restart), so the palette, CLI and agents get
  them; each surface adds `plugin.<name>.show.<surface>`, whose availability is the
  surface's. `when` clauses compile to predicates the daemon evaluates over host facts
  (thread, project, workspace, the thread's pull request and its checks, fetched
  lazily) and the plugins' own `context/set` facts.
* **Surfaces.** An instance per scope value (`<plugin>/<surface>/<global | thread:id |
  project:id | worktree:path | pr:owner/repo#n>`), opened on the first watcher, closed
  10 minutes after the last (`idle`), or at once when its thread or project goes
  (`context_gone`, on the daemon's thread and project events) or its `when` stops
  holding (`unavailable`). Views are the `pluginsdk/ui` JSON, validated by the daemon
  (schema, limits, keys, URLs, the commands a view may run, secrets), re-encoded,
  versioned and coalesced per watcher; log nodes take appends. `PluginService.WatchSurface`,
  `GetSurface` and `Act` serve them; an act names an element of a recent version and the
  daemon fills in the rest. A form's secret input with `store` goes to the Keychain, and
  the plugin sees only `{key, stored}`.
* **Events, flags, environment.** `events/subscribe` feeds a plugin the EventService
  sources it was granted, on the same loop as `Watch`, through a bounded drop-oldest
  queue that resends a snapshot after drops. `thread/setFlag` puts an attention or error
  flag on a thread (an overlay in the thread store; never the stream's status).
  `session/setEnvironment` contributes env, PATH entries and `--add-dir`s to new threads
  through the thread store's spawn extras (§6).
* **Own threads and terminals** (permissions `threads`, `terminals`;
  `docs/notes/plugins-6-thread-terminal.md`). A plugin's thread is an ordinary thread
  owned by `plugin:<name>` (`threads.owner`) with a cwd and env/add-dirs of its own
  (checked like a session environment, applied on every spawn in place of the plugin's
  session environment): hidden from filtered lists (`thread list --plugin`), the sidebar,
  attention and the dock, still running, stopping and costing like any. Its terminal is
  labelled `kind=plugin` (`internal/termlabel`). Both are rendered by `thread` and
  `terminal` view nodes; disabling or removing the plugin archives the threads and closes
  the terminals.
* **SDK** (`pluginsdk/`, a nested module, stdlib only, Go 1.24, `replace`d into the
  main module): manifest types and validation, the JSON-RPC `Conn`, `Serve` and `Host`;
  `pluginsdk/ui` (typed nodes, builders, `Validate` with the host's rules);
  `pluginsdk/plugintest` (a fake host). Plugin repositories `go get` it pinned at a
  commit until it is tagged `pluginsdk/vX.Y.Z`.
* **GUI** (PR 5): plugin surfaces are a generic surface kind in the side panel
  (`panel.plugin.<name>.<surface>`), available exactly when their show command is; one
  renderer component per node kind, drawn with the app's own components (no HTML from
  plugins, no filled buttons, neutral header icon, emerald only for `ok`); one
  `WatchSurface` per visible surface; host-side `command`, `openUrl` and `copy`; form
  drafts per instance and tab; the consent dialog is `plugin.enable`'s confirm.
* **Skill.** `code-foundry-plugin` (`internal/skills`) teaches an agent the loop: copy
  the template (`plugins/examples/minimal`, embedded), `go get` the SDK at the commit
  this daemon was built from, `plugin dev`, `plugin logs`, `plugin surface` / `plugin
  act`, plugintest, release tarballs (`make release`, one script for `release.yml` on
  the runner the user names and for a release by hand when they have none), the
  registry pull request. Its CLI and host
  command references are rendered from the registry at start; reserved names, event
  sources, host facts and view limits are filled in from the code.
* **Registry** (PR 7): `alexwaumann/code-foundry-plugins` serves `index.json` built from
  `plugins/<name>.json` entries (release tarball URLs per macOS architecture with
  SHA-256, permissions equal to the manifest's), validated by its CI. No registry is
  configured by default: `plugins.registries` is empty until the user adds one.

**Skills marketplace** (not Code Foundry plugins: Claude Code plugins and standalone
skills; `docs/notes/skills-1-registry.md`). `internal/store/skill` serves Settings →
Skills. Its registries are the marketplaces Claude Code has (`claude plugin marketplace
list --json`; no setting of ours, never a clone of ours); each checkout is read by
`skill/marketplace`: the plugins `.claude-plugin/marketplace.json` lists (with
`plugin.json` and their skills) and every `SKILL.md` directory under
`enterprise|community/skills/**`, dated by one `git log --name-only` pass cached by
HEAD (a skill's version is its last commit's YYYYMMDD). `Search` ranks name hits first
and caps the page. Installed is Claude Code's plugin list plus the skill directories in
`~/.claude/skills` and `<home>/skills/disabled`, joined with `skill_installs` (no row:
a local skill); update offers are derived (plugin: the checkout's `plugin.json` version
semver-newer than the installed copy's, else the index's; skill: a newer commit). The
`claude` calls sit behind `skill.Claude` (fake in `skilltest`), with
`advanced.claude_path` read live. The daemon reads the checkouts at start (no network)
and on the plugin registry's hourly tick runs `claude plugin marketplace update` per
marketplace (deepening Claude Code's shallow clone once) and re-reads; each read
publishes `skill.Changed{Epoch}`. The lifecycle (`docs/notes/skills-2-lifecycle.md`) is
the store's too: a plugin is `claude plugin install|enable|disable|update|uninstall
<name>@<marketplace> --json`, a skill is a directory it copies (staged beside, then
renamed), moves to and from `<home>/skills/disabled` and records; a setup script runs
only in a visible `kind=setup` bottom-panel terminal (`skill.setup`), whose exit 0 the
daemon records. The `skill.*` commands drive it. `SkillService`
(`docs/notes/skills-3-api.md`) only reads (`Search`, `Installed`, `Registries`; `Watch`
and the EventService skill source carry the epoch); the GUI's `stores/skill.ts` re-reads
on a new epoch while the page is open and runs the `skill.*` commands for every action.

## 11. Conventions

* Features add files, not edits. Registries over switch statements. Messages owned by the
  emitter.
* Pure functions with table tests for anything with branches: stream status, layout,
  command availability, snapshot serialization.
* Every store has an interface in its own package and a fake in `<store>/<store>test`.
* Go 1.26 (required by the libghostty-vt bindings). `context.Context` first, errors wrapped with `%w`, no panics outside `main`.
* Logging: `log/slog`, JSON to `$CONFIG/logs/daemon.log`, text to stderr in dev.
* Frontend never imports generated protobuf types outside `src/api/`; it maps to view
  models at the boundary.

## 12. Non-goals for v1

* Cross-platform. macOS only.
* Keeping PTYs alive across daemon restarts.
* Remote daemons. The protocol allows it; nothing implements it.
* A custom terminal renderer. xterm.js is the renderer until measured otherwise.
