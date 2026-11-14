# code-foundry — Architecture

A macOS desktop app for running and supervising fleets of Claude Code threads
across many git repositories and worktrees. Every user has `git`, `gh` (authenticated),
and `claude` (authenticated) installed on a recent MacBook Pro running current macOS.

This document is the source of truth for structure and boundaries. Feature-level
docs, with the decisions behind each change, are in `docs/notes/`; git history has the rest.

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
  (`docs/notes/dictation-3-host.md`). While `dictation.enabled` and `dictation.anywhere` are
  on (it reads the settings from the same stream) it keeps a menu bar item, and closing the window hides it
  and drops the Dock icon instead of quitting (`gui/menubar.go`,
  `docs/notes/dictate-anywhere-settings.md`). For a session whose client is `system` it
  shows the dictation overlay, a non-activating panel with its own small page
  (`dictation-overlay.html`) that reads the daemon and asks to be hidden when it has played
  the session (`gui/overlay.go`, `docs/notes/dictate-anywhere-overlay.md`).
  With dictation on and Accessibility granted it listens for the hold key on a listen-only
  event tap: it runs `dictation.hold` for the window's composer, or opens a `system` session
  and pastes the phrases into the app in front (`gui/hold.go`,
  `docs/notes/dictate-anywhere.md`). One GUI runs per home: a second launch shows the first's
  window and exits (`gui/singleinstance.go`).
  No business logic lives in the Wails host.
  A home other than the default one gets its own WebKit data store (`gui/webstorage.go`).
* **CLI** subcommands (`code-foundry thread new --project foo`, `code-foundry thread focus <id>`, …)
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
channels: a `vX.Y.Z-tip.N` prerelease per green sweep on main (the full suite on the
merged tree, `docs/notes/ci-rethink.md`), and stables promoted from the newest sweep-green
commit with `make promote` (`docs/notes/release-channels-handoff.md`).

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
  daemon/                  bootstrap, listeners (UDS, loopback API, loopback pages), token file, lifecycle,
                           and the glue between stores (layout.go: thread and terminal events to
                           layout ops, §14)
  wstunnel/                one Connect server stream over one WebSocket, replayed through
                           the loopback listener's bearer check and handlers
  presence/                whether the user is looking at the app (GUI clients' visibility
                           and focus), with ordered subscribers
  api/                     Connect service handlers. Thin. One file per service.
  bus/                     typed in-process event bus (generic pub/sub, bounded, non-blocking)
  command/                 command registry: name, arg schema, when-predicate, handler
  claudestream/            the stream-json / control protocol client (pure Go)
  layout/                  the window shell's model and every rule on it, pure: spaces, pane trees,
                           tabs, surface identity, placement, smart swap, a thread's remembered
                           tabs, drafts, the first-load import (§14)
  store/
    terminal/              PTY + libghostty-vt actor per terminal; output tee; snapshots
    layout/                the layout's one writer: SQLite rows, snapshot, events (§14)
    thread/                threads: claude -p over stream-json, items, naming, status, resume
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
                           process (stdio JSON), one session at a time, the model kept loaded
                           (docs/notes/dictation-2-daemon.md)
    search/                the search dialog's history and Agent search's hidden runs
                           (claude over stream-json, not threads), quote-verified hits, Promote
                           (docs/notes/search-5-agent-daemon.md)
    settings/              $CONFIG/settings.toml: schema, validation, reload on hand edits
    skill/                 the Skills marketplace: Claude Code's marketplaces, installs (§10)
    usertheme/             the user's theme files in <home>/themes (§13)
  capability/              scoped bearer tokens (Agent search's run): the RPCs and commands a
                           scope allows, issue/revoke/expiry; the loopback auth and the
                           command handler check them
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
                           (the entry skill, orchestrate, help, plugin, pages), and Ember's own (ember)
  pluginscaffold/          `plugin new`: a plugin repository from the minimal example (§10)
  fsx/                     the home-directory boundary, directory completion, file reads and writes
  fuzzy/                   path ranking for `@` completion and the file finder (pure)
  logfile/                 a size-capped log file with one rotation (daemon and plugin logs)
  model/                   the one list of Claude models the app offers
  pricing/                 Claude API token prices for the usage figures
  termlabel/               the label contract on terminals (kind, owner, free shells, the quick slot)
  tcc/                     which process macOS's privacy checks (TCC) treat as responsible
  version/                 the build version and provenance
  bridge/, pagelib/,       what HTML pages the model shows load from /cf/ and the preview
  preview/, proxyfetch/,   route, cf.fetch, and the daemon's view of the colour themes (§13)
  theme/
pluginsdk/                 the plugin SDK, its own module (stdlib only, Go 1.24): manifest, protocol,
                           Serve, Host, ui (view model), plugintest (§10)
plugins/                   example plugins, built by `make plugins`: hello (every protocol method),
                           minimal (the plugin skill's template, embedded by embed.go)
gui/
  main.go                  Wails v3 host (thin)
  frontend/                Vite + React 19 + TypeScript + Tailwind v4 + shadcn + Zustand
  build/                   Wails build assets; darwin Taskfile builds the bare GUI executable
scripts/                   install.sh (embedded in the binary), package.sh, release.sh,
                           next-version.sh, ghostty-vt.sh, whisper-cpp.sh, attest.sh, drive.sh,
                           sweep-report.sh, go-test.sh, guide-eval/
docs/                      this file, GETTING-STARTED.md and THEMES.md (embedded by embed.go,
                           package docs, for the help skill), notes/ (decisions and gotchas, a note per step)
```

Module path: `github.com/alexwaumann/code-foundry`.

## 4. Protocol

Protobuf schemas under `proto/`, compiled with `buf`. Server is `connect-go`; the browser
client is `@connectrpc/connect-web`; the Go client is `connect-go`. Both speak binary protobuf:
Connect-Web defaults to JSON, so `api/endpoint.ts` asks for binary (`?json=1` in a development
build reads the traffic as JSON; `docs/notes/binary-transport.md`).

Transport:

| Client | Transport | Auth |
|---|---|---|
| CLI, Wails host | Unix socket `$CONFIG/daemon.sock` | filesystem permissions (0600) |
| Frontend, unary calls | `http://127.0.0.1:<random port>` | bearer token from `$CONFIG/daemon.token` (0600) |
| Frontend, every stream (the dictation overlay's too) | `ws://127.0.0.1:<same port>/stream/<procedure>`, one WebSocket per stream through `api/wsFetch.ts`, with no fallback to fetch, never on the Unix socket or the pages listener (`internal/wstunnel`, `docs/notes/ws-tunnel.md`, `docs/notes/ws-transport.md`). A daemon from before the tunnel opens the update dialog (`TUNNEL_SINCE`, `lib/update.ts`) | `allowedOrigin` before the upgrade, then the same bearer token in the first frame; the client counts what it has taken and the daemon stops 8 MiB ahead |
| CLI inside a thread | `CODE_FOUNDRY_ENDPOINT` (the loopback listener) | `CODE_FOUNDRY_TOKEN`; both set in every thread's Claude env, never auto-starts a daemon |
| CLI inside Agent search's hidden run | `CODE_FOUNDRY_ENDPOINT` | `CODE_FOUNDRY_TOKEN` is a token scoped to that search (`internal/capability`): `thread.search`, `thread.read` and its own `search.report` only, revoked when the run ends (`docs/notes/search-5-agent-daemon.md`) |

Every Claude process also gets `CODE_FOUNDRY_THREAD=<its thread id>`, which the CLI sends
as its default `--context-thread`: an agent's `code-foundry terminal new` or `action run`
belongs to its own thread and opens as a tab linked to it, placed beside it, without taking
the user's focus (`docs/notes/actions-1-daemon.md`, `docs/notes/shell-6-lifecycle.md`). The daemon puts
the directory of `CODE_FOUNDRY_BIN` (the CLI it runs as) on the PATH of everything it
starts, so a thread finds `code-foundry` by name (`docs/notes/orch-small-fixes.md`).

The Unix socket and the loopback listener serve the same handlers. The port and token are
written by the daemon on start; the Wails host reads them and injects them into the page
before load. A third listener, the pages listener, serves no API at all (§13).

Services (v1):

* `ThreadService`, the lifecycle — Create, Fork, List, Get, Rename, Remove (keeps a
  24 h in-memory tombstone: Get is NOT_FOUND with a `RemovedThread` detail, Wait answers
  `removed`, List adds them on `include_removed`, subscribers get a `removed` wake;
  `docs/notes/removed-thread-signal.md`), RunIn, Move,
  Pin (the user's pin, persisted; `docs/notes/workspaces-4-sidebar.md`), Archive (close,
  remove the thread's shells, unpin, stamp `archived_at`; pin and send
  unarchive; `docs/notes/archive-threads-1-daemon.md`), Snooze (close, remove the
  thread's shells, unpin, unarchive, set `snoozed_until`; the store wakes it on the wall
  clock into NEEDS_ATTENTION "snooze ended"; `docs/notes/snooze-threads-1-daemon.md`;
  with `save` the same with no wake time, `saved_at` instead of `snoozed_until`;
  `docs/notes/save-for-later-1-daemon.md`), Wait (block until a thread settles, by default: idle or needs attention, a pending prompt included; or until it is idle, needs attention, has an error or is disconnected; `thread.wait`, `docs/notes/agents-1-wait-events.md`, `docs/notes/thread-wait-settled.md`), Label, Report and SetBudget (agent metadata: labels, a report, a spending limit whose budget stop interrupts Claude into NEEDS_ATTENTION "budget reached"; with Create's created_by and brief, `docs/notes/agents-2-metadata.md`), Subscribe, Unsubscribe and ListSubscriptions (wake subscriptions: the daemon sends a thread a wake message, a user message with origin WAKE, when a target thread settles or meets another condition, or an action run finishes; persisted, edge-triggered from the thread store's commit and again on each new pending request, 60 per subscriber per hour; `thread.new --notify`; `docs/notes/agents-4-wake.md`, `docs/notes/wake-detail.md` for what a settled wake says; WatchThread carries the watched thread's list; StopWaiting removes its wakes and stops its background shells: `docs/notes/wait-list-daemon.md`), StageAttachment (images and PDFs a message refers to, as bytes or an absolute path the daemon reads; `docs/notes/pdf-attachments-1-daemon.md`, `docs/notes/attach-by-path.md`) and ReadAttachment (a staged file's bytes).
  Also RegenerateName (a new name from the last three turns, `docs/notes/regenerate-thread-name.md`),
  RetrySetup, CancelSetup and DiscardSetup (a background setup's ways out, §6), AddProject and
  RemoveProject (a thread's project set, `docs/notes/thread-project-set.md`), LinkPullRequest
  (a link by hand) and PullRequestOwner (the thread a copied link comes from;
  `docs/notes/pr-daemon-actions.md`, `docs/notes/pr-task-forward.md`), CheckPlacement (where a
  new thread would go, nothing made; `docs/notes/thread-info-facts.md`) and Ask (a created
  thread asks its creator, who gets a wake; `docs/notes/thread-ask.md`).
  The daemon starts a thread's process when a message is sent and stops it once the
  thread has idled at its prompt past its prompt cache expiry
  (`docs/notes/thread-lifecycle.md`); the thread list reaches clients through
  EventService's thread list source. Create takes a project set (`project_ids`), can
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
* `ThreadService` — the conversation: ListItems, WatchThread (server stream: an items
  snapshot, then appended/updated items, text deltas and pending-request changes, all
  seq-ordered; an open WatchThread marks the thread's turns seen while a GUI window is
  visible and key, `docs/notes/alerts-foreground.md`),
  Send (also while busy; a stopped thread starts with the message), Respond (a permission request or AskUserQuestion: allow,
  allow for session, deny with a reason, answers), Interrupt, SetModel,
  SetPermissionMode, SetEffort (Claude has no live effort switch: the runner restarts
  the process with `--resume` and the new `--effort`, at once when idle, else when the
  running turn ends, `Thread.effort_pending` meanwhile; the thread stays connected; the
  new process gets the thread's allow-for-session grants again as `--allowedTools` /
  `--add-dir`; a stopped thread's model, mode and effort changes only go to its row), McpStatus and McpReconnect (the thread's MCP servers as Claude last
  reported them, checked at the start of every turn, kept and persisted while the thread
  is stopped; a refresh or reconnect starts a stopped thread without a prompt; WatchThread carries
  each check; `docs/notes/mcp-panel.md`), SlashCommands (the commands Claude reports in its
  initialize reply and `commands_changed` pushes, minus a daemon-side deny table, kept and
  persisted while the thread is stopped; the items snapshot and WatchThread carry them; Send refuses a message starting with
  a command the app replaces, such as `/clear`; `docs/notes/slash-commands-1-daemon.md`),
  Compact (`/compact`), Restart (a running process again with `--resume`, to pick up what
  changed outside the conversation; `docs/notes/plugins-env-restart.md`), StopShell (one of
  the thread's background shells; `docs/notes/thread-servers.md`), ListPrompts (the user's
  earlier prompts; `docs/notes/prompt-history-1-daemon.md`), Search (§6) and AddNote (a
  `note` item, no turn). ShowHtml, ShowTheme, PageStorage, SetPageStorage and ProxyFetch
  serve the pages the model shows (§13).
  The items snapshot and WatchThread also carry the thread's subagent runs (`agents`: every
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
* `EmberService` — WatchBoard (server stream: the whole board, then
  again on every change of a task, of Ember's state, of a task's worker thread or of its
  timers, and a heartbeat when quiet): Ember, the resident agent, and its task board,
  each task with its worker's derived status and report (`docs/notes/ember-2-store.md`),
  and its pending timers (`EmberBoard.timers`, followed through the thread store's
  `SubscriptionsChanged`). Read only: Ember and the CLI change the board
  with the `ember.*` commands; `ember.*` settings turn it on and pick its models. Its
  chat is its resident thread. A thread Ember or a thread below it creates without a
  model runs on `ember.worker_models` (round robin) at `ember.worker_effort`
  (`CreateThreadRequest.model_defaulted`: the CLI's settings default counts as none).
* `TerminalService` — Create, List, Get, Attach (server stream: initial screen snapshot then
  live output chunks; cancelling it detaches), Write (input bytes), Resize, Kill, Remove,
  and Close (kill, wait for the exit, remove; shells, action runs and skill setups only).
* `ProjectService` — Register (a git repository, or any folder as a project without git;
  "~" expands, the path must be absolute; the Add Project dialog's Local folder tab calls
  it directly, the CLI through `project add <folder>`), InspectFolder (what Register would
  make of a folder: a repository, else the git repositories directly inside it; the Add
  Project dialog asks first and offers a folder of repos as a rooted workspace through
  the `project.add-workspace` command, which registers each repository and creates the
  workspace with the folder as its root; `docs/notes/workspaces-v2-6-scan.md`),
  Unregister, List, Get, CreateWorktree (optionally fetching the base first), RemoveWorktree,
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
  Refresh (a status reconcile now), Rename (the display name only; nothing on disk), ListRefs,
  Watch, GetWorktreeDetail (the files changed against the base branch, Phase 3a),
  InitGit (`git init` and an empty first commit in a project without git;
  `docs/notes/add-project-2-nogit.md`), SearchGitHub and LookupGitHub (GraphQL through
  the gh store, for the Add Project dialog), Clone (server stream: `gh repo clone` into
  `<config home>/projects/<owner>/<repo>`, output lines, then the registered project;
  `docs/notes/add-project-3-dialog.md`), Create (a new project in
  `<config home>/projects/<name>`: git init, an empty first commit, register),
  ListPublishOwners (the viewer and their organizations with the visibilities each
  allows when GitHub says) and Publish (`gh repo create --source --remote origin --push`
  for a git project without origin; gh's error verbatim;
  `docs/notes/add-project-4-create.md`) and Delete (unregisters a project Create made and
  removes its folder, for a new project the dialog cancels).
  CompareWorktree lists what differs between any two of a checkout's merge base, working
  tree, index or a ref, GetWorktreeCompareFile reads one file's two sides on demand,
  ListCompareCommits lists the commits between them and GetCompareCommit one commit's
  message (`docs/notes/diff-commits.md`);
  refs and paths from callers never reach git as given (`docs/notes/diff-viewer-1.md`).
* `GhService` — GetViewer, GetDashboard, GetRepoActivity, GetBranchPullRequests (the
  viewer's PR dashboards, six months of stats (`docs/notes/gh-stats-six-months.md`),
  default-branch CI, the viewer's PRs on a branch), GetPullRequest (on demand). The daemon
  tracks the GitHub repositories of registered projects itself. Its events are
  EventService's `gh` source: data events go out only when data changed; `Polled` after every poll carries the
  freshness time. The pull request tab: GetPullRequestDetail (on demand, cached per PR,
  invalidated by the poll's fingerprints), ListReviewerCandidates, SetReviewRequest,
  RevertPullRequest (`docs/notes/gh-pr-detail.md`), MergePullRequest, SetPullRequestDraft,
  SetPullRequestAutoMerge and SetPullRequestCheckbox (each invalidates the detail),
  SubmitPullRequestReview and
  AddPullRequestComment (GitHub's refusals relayed as FAILED_PRECONDITION;
  `docs/notes/pr-review-submit-1-daemon.md`), and GetPullRequestDiff and GetPullRequestFile
  for its Code tab (§7).
* `GitOpsService` — Fetch, Pull, Push, CreatePullRequest, OpenPullRequest, OpenEditor,
  Reveal, OpenUrl. One operation at a time per worktree; a failed operation
  is a result (state FAILED, output), not an RPC error. The GUI reaches it only through
  the git.*, pr.*, worktree.open.editor, worktree.reveal and view.open.url commands, plus
  two direct reads: ListEditorApps and ListAppIcons (Finder's and the editors' icons,
  read from the installed bundles; `docs/notes/app-icons.md`).
* `CommandService` — List(context) → available commands with their arg schemas; Invoke.
  A command that asks first fails Invoke with a `ConfirmationRequired` detail; clients ask
  and invoke again with `confirmed`. A confirmed command may ask a second time with
  `args` to merge (removing a worktree would delete uncommitted work: `force`) and
  optionally the result that stands if the user declines; the GUI asks again, the CLI
  prompts again on a terminal, and `--yes` never answers it
  (`docs/notes/dirty-worktree-confirm.md`).
* `UiService` — WatchIntents (server stream: focus thread, open palette, …); PublishTheme
  (the GUI's active theme and its resolved slots, §13) and GetTheme (the theme last
  published, for the dictation overlay's page); PublishThemeReport (the GUI's contrast
  report on a user theme, which `theme save` and `theme check` print); WatchShots and
  PublishShot (the app's host is the one capturer of `plugin surface --shot`'s PNGs,
  `internal/shot`; it holds WatchShots and answers one request at a time, `gui/shot.go`). Commands emit intents in-process (`command.BusEmitter`). Intents
  carry only what the layout does not hold: a ShowView for window state (the sheets,
  back and forward, thread info, full screen, the finds, a plugin surface's
  `panel.<kind>`), FocusThread and FocusTerminal (the keyboard into a prompt or a terminal
  once the layout has focused its tab). Tabs, panes and spaces are the layout's
  (`LayoutService`); the `view.open.*` verbs send no intent (`docs/notes/shell-22-retire-verbs.md`).
  `ui.presence` tells a thread's model whether the user is looking and whether a window
  shows its thread (`docs/notes/control-1-thread-scoped-views.md`). A Notify may carry a `link`
  ("settings:<page>"), a button on the toast (`docs/notes/memory-page.md`).
* `LayoutService` — Get, Apply, SetViewport, ImportLegacy: the window shell's spaces, pane
  trees and tabs, which the daemon holds so the CLI and a thread's model arrange the same
  layout a key press does (§14). Apply takes one `LayoutOp` (a case per op of
  `internal/layout`) and answers where it landed (space, pane, tab, placement rule, what
  closed, was kept or restored); every commit is a delta on EventService's `layout` source.
  SetViewport reports a window's pane area, which placement measures in. ImportLegacy
  brings a classic window's stored panels over once (§14).
* `EventService` — Watch: one server stream that multiplexes every store's events and UI
  intents (sources project, workspace, terminal, thread list, thread, gh, gitops, theme,
  settings, update, action, plugin, skill, memory, search, layout, ui; the thread source carries threads' pending requests only, a
  snapshot then changes, never items; filterable). On connect it sends each source's snapshot in that order, then live events; a source that drops events for a
  slow client resends only its own snapshot. This is the GUI's only long-lived sync
  stream, and `code-foundry events --source …` reads the same one. Live events pass
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
* `SettingsService` — GetSchema, Get, Update over `$CONFIG/settings.toml` (TOML,
  hand-editable, reloaded on change). See `docs/notes/phase3b-settings.md`. ListBackdrops,
  ImportBackdrop, RemoveBackdrop and ReadBackdrop keep the user's backdrop images (copies in
  `$CONFIG/backdrops`, internal/store/backdrop) that `appearance.backdrop = custom` shows
  (`docs/notes/custom-backdrop.md`); Update refuses `custom` unless `appearance.backdrop_file`
  names one of them (`docs/notes/backdrop-custom-guard.md`).
* `UpdateService` — Get, Check, Download, Install, Relaunch, RequestRestart, Watch. The
  hourly release check on the `update.channel` setting's channel (stable: the newest full
  release; tip: the highest release, prereleases included; re-checked at once when the
  setting changes; `Newer` is the only install rule, so no switch offers a downgrade),
  download progress, and relaunch and restart requests. A check that finds a newer release
  downloads it at once (`docs/notes/update-auto-download.md`); Download (`app.update`) is
  the fallback by hand. A download only stages the release in `app.new`; the install on disk changes inside the restart, so a
  window reopened meanwhile still matches its daemon. Nothing restarts automatically.
  `app.restart` (the GUI's "Restart Now"; confirmed, warning about busy threads) installs
  a downloaded update (two renames), publishes `restart_requested`, then the daemon exits
  like `daemon.restart`; GUI hosts relaunch once their Watch stream ends and the new
  window auto-starts the installed daemon. `app.relaunch` and `daemon.restart` restart
  the halves separately and install nothing. See `docs/notes/update-restart.md`,
  `docs/notes/update-download-then-install.md` and `docs/notes/release-channels.md`.
* `WorkspaceService` — List, Create, AddProject, RemoveProject, Rename, SetDefaultPrimary,
  SetRoot, Remove. A workspace is a saved set of projects (`members`, sorted ids), a
  `default_primary` (a member or `workspace`; a project named "workspace" wins over the
  keyword), an optional `root_path` (under home, never home itself nor inside a
  registered project; `root_missing` when it moved, which SetRoot repairs) and a managed
  dir, `<config home>/workspaces/<id>` (0700, repaired at start): a synthetic workspace
  keeps its CLAUDE.md, AGENTS.md and `.claude/skills` there; a rooted one holds links to
  its root's, re-checked at every spawn, and its files are read from the root itself.
  Names are NFC and never look like an id. The daemon drops unregistered projects from
  every workspace and refuses removing a synthetic one while a thread that is not
  archived runs in its managed dir; the workspace events source reads every folder again on connect. No
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
  ReadFile and WriteFile serve the file viewer: WriteFile replaces a file atomically
  anywhere under home except the config home outside its checkouts, and answers a file
  that changed since the read with a plain `conflict` field (`docs/notes/file-edit-1-daemon.md`).
  ReadFile and PreviewFile also read the temp folders (`/tmp`, `$TMPDIR`), where agents write; only
  they do, so a temp file has no editing and no bridge (`docs/notes/read-temp-files.md`).
  The File tab's editor calls it directly; a draft lives only in the window's memory and only
  the window saves it: `file.save` refuses every caller that reaches the daemon
  (`docs/notes/file-edit-2-gui.md`). `view.open.file --edit` asks the user to edit a file: the
  verb refuses what the tab could not edit and writes the request into the File tab's params
  (`asker`, `askId`, `note`), nothing from inside the file reaches its answer, and the tab's
  Save and tell thread sends one ordinary message after the write
  (`docs/notes/file-edit-3-agent.md`, `docs/notes/shell-22-retire-verbs.md`).
* `ActionService` — List, Create, Update, Delete, Run, GetRun, WaitRun, StopRun, LastRun. Per-project
  actions (name unique per project ignoring case, command, icon, in terminal or in the
  background, run on worktree create, position; SQLite, cascading with the project) and
  their runs (in memory, 50 per project; a record of each run, 500 per project, persists
  for `action list` and LastRun, the action a thread's info card offers). A run belongs to a thread or a worktree like a
  shell, runs `$SHELL -lc <command>` there with `CODE_FOUNDRY_PROJECT_ROOT` and
  `CODE_FOUNDRY_WORKTREE`, in a `kind=action` terminal or as a background process whose
  last 64 KiB of output WaitRun returns; StopRun ends one (`action.stop`, and an
  interrupted `action run --wait` of a background run). A new thread's worktree runs the
  project's on-worktree-create actions in the background, one after another, each stopped
  after 10 minutes; `run_finished` events carry every end
  (`docs/notes/actions-1-daemon.md`). The action.* commands are the CLI's surface.
* `PluginService` — List, Enable (with consent, else the text to consent to), Disable,
  Restart, Dev (link a folder and enable it), Reload, Logs, FollowLogs, ListSecrets,
  DeleteSecret, and the registry's Browse (`refresh` reads every registry again), Install, Update and
  Uninstall (`docs/notes/plugins-7-registry.md`). Plugins are executables in `$CONFIG/plugins/<name>` the daemon runs
  and speaks newline-delimited JSON-RPC 2.0 with over stdio; their manifest commands are
  `plugin.<name>.<command>` (§10; `docs/notes/plugins-1-core.md`; design in
  `docs/sketches/plugins/`).
  WatchSurface, GetSurface and Act serve plugin surfaces: views (the `pluginsdk/ui`
  JSON the daemon validates) per instance `<plugin>/<surface>/<scope>`, opened on the
  first watcher; each surface's `plugin.<name>.show.<surface>` command carries its
  availability (a when clause over host facts) in CommandService.List and opens a thread or
  pr surface as a tab linked to the thread, placed by the layout's rules (`--focus` moves the
  user's focus; `docs/notes/plugins-2-surfaces.md`, `shell-24a-import-moves.md`).
  Environment returns what plugins add to new threads
  (`session/setEnvironment`: env, PATH entries, `--add-dir`s, scoped by project; `plugin
  env`). Plugins subscribe to EventService's sources over the protocol (`events/subscribe`,
  `api.PluginFeed` on the same loop as Watch, a bounded drop-oldest queue per plugin) and
  raise flags on threads (`thread/setFlag`; `Thread.flags`, ThreadService.ClearFlags,
  `thread flags`); `docs/notes/plugins-3-events-flags-env.md`.
* `SkillService` — Search, Installed, Registries: the Skills
  marketplace, read only; its actions are the `skill.*` commands (§10;
  `docs/notes/skills-3-api.md`).
* `MemoryService` — Get (the whole memory with provenance and caps): the app
  memory, read only; its actions are the `memory.*` commands (`docs/notes/memory-dir.md`).
  The GUI shows it on Settings › Memory, fed by the EventService memory source
  (`docs/notes/memory-page.md`).
* `DictationService` — Watch (the whole state: on/off, the anywhere, hold key and sounds
  settings, model and download, this Mac, the open session, mic denied, the host's
  Accessibility report, the window's composer target), Download, CancelDownload, RemoveModel, Start, Stop,
  Session (one session's levels, phrases and end), Audio (the Wails host's microphone
  client stream), MicDenied, Accessibility, Inputs (the host's input devices), ComposerTarget: voice dictation into the composers
  and, through the host's hold key, any app, transcribed on this Mac by the
  code-foundry-dictate engine the daemon runs (`docs/notes/dictation-2-daemon.md`,
  `docs/notes/dictate-anywhere.md`).
* `SearchService` — StartAgent, Watch (server stream: the entry, then its steps, hits,
  answer and end), WatchRecent, Stop, ListRecent, Get, OpenHit, MarkSeen, RecordFind, Forget,
  Clear, Promote, Report: the search dialog's history (the last 50 searches) and Agent
  search, a hidden claude -p run on the utility model that searches the user's threads with
  the CLI and reports quote-verified hits; Promote continues it as a thread
  (`docs/notes/search-5-agent-daemon.md`).
* The colour themes have no service of their own: EventService's `theme` source carries
  the curated catalog's ids and the user's theme files with their contents
  (`internal/theme`, `internal/store/usertheme`, files in `<config home>/themes`); the
  `theme.*` commands save, copy and delete, and the `appearance.theme_dark` /
  `theme_light` settings pick. The daemon derives no colour: the GUI resolves every
  theme's slots (`docs/notes/user-themes.md`, `docs/THEMES.md`).
* `HealthService` — Ping, Version.

Rules:

* Streams carry `bytes` payloads for terminal output. Never base64, never re-encode.
* Every message type is owned by the service that emits it. No shared "misc" proto.
* Breaking changes bump the package version. v1 is append-only once Phase 1 lands.

## 5. Terminal store

One actor per terminal:

```
PTY (creack/pty) ──reader goroutine──► tee ──► libghostty-vt (feed)
                                          └──► attached subscribers (bounded channels)
```

* The actor is the only goroutine that touches its vt instance. cgo is not thread-safe
  across goroutines without serialization; we serialize by construction.
* `Attach` sends a **snapshot** built by libghostty's VT formatter (scrollback, the screen
  with SGR attributes, cursor, modes, and the primary screen under an alternate one;
  `snapshot.go`), then live chunks. The snapshot is a byte sequence xterm.js can consume
  after a reset.
* Slow subscribers are dropped, not blocked. The PTY reader never stalls on a client.
* The terminal store is program-agnostic. It spawns argv/env/cwd. Shells are its only
  production use since threads run headless; its Observer and ScreenText hooks remain
  for a future program that wants them. `ScrollbackText` (scrollback + screen as plain
  text, from the emulator) serves plugin `terminal/read` with `scrollback`.
* The emulator answers terminal queries itself, color queries included: the GUI's published
  theme gives it default colors (`SetColors`), and xterm.js swallows the queries.
  A reply from the GUI would land after the emulator's own replies and could reach the
  shell as typed text (`docs/notes/terminal-color-replies.md`).
* Resize is driven by the attached GUI terminal; the daemon applies it to the PTY and vt.
  With no attachment, size is the last known size.
* Labels are opaque to the store; their contract lives in `internal/termlabel`: `kind`
  (`shell` on a shell `terminal.new` started, `action` on an action run in a terminal),
  `thread` (the owning thread), `project` and `worktree` (the owning worktree), and on
  action terminals `action`, `action.name` and `action.run`. `terminal.new`
  gives every shell an owner (thread, else worktree) and refuses a cwd outside every
  registered project. Two more cases: a **free shell** (`terminal.new-free`, cmd+shift+t:
  `kind=shell` and no owner, in the home directory; `termlabel.Free`, `IsFree`) and a
  thread's **quick terminal** (`slot=quick`, `terminal.new --quick`; one per thread, the
  command serialising the check and the start). `terminal.reset` starts a fresh shell in the
  owner's directory labelled `replaces=<old id>`, then closes the old one, so its tab can
  follow (`docs/notes/shell-5-terminal.md`). `SetLabels` changes a running terminal's labels
  without touching its process (the first-load import labels quick shells). The shell
  reaper (`internal/daemon/shells.go`) removes a shell when it exits or when its worktree,
  project or thread goes away (a free shell only when it exits), with a periodic sweep for
  dropped events (`docs/notes/bottom-panel-1-daemon.md`). An exited action terminal stays,
  its tab too (the user reads its output; closing the tab removes it), but goes with its
  owner like a shell (`docs/notes/actions-1-daemon.md`).
* Facts, for terminal tabs' names and the quick terminal's hint (`facts.go`, `proc.go`): the
  shell's live directory (`live_cwd`, `proc_info` on its main pid), the foreground job's
  command line (`foreground`, from the PTY's foreground group and `kern.procargs2`) and the
  last command that ended (`last_command`), sampled on the actor 200 ms after output and
  again 1 s and 4 s into a quiet spell, published with `TerminalUpdated`. No shell
  integration: an idle terminal costs nothing (`docs/notes/shell-5-terminal.md`).

## 6. Thread store

Owns the Claude processes. It uses the terminal store only to reap a thread's shells;
before it removes them for an archive, a snooze or a removal it calls `Options.ShellsGoing`
with the reason, so the layout glue can record what each ran while they still exist (§14).

* Spawns `claude -p` over stream-json in a worktree with the chosen
  model/effort/permission-mode flags through `internal/claudestream` and sends the first
  prompt as the first user message (with image blocks; see below). It records the Claude
  session id (from `~/.claude/projects/<slug>/*.jsonl`) so dead threads can be resumed
  with `claude --resume`.
* A thread has a **project set** (`project_ids`, sorted by id; persisted as a JSON column)
  and one **primary** (`project_id`/`worktree_path`: the cwd); a thread without a project
  has an empty set, runs in the home directory (`Options.Home`), pre-trusted like any cwd,
  and RunIn refuses it (`docs/notes/no-project-1-daemon.md`); Move takes it into one
  project or workspace, placed by Create's code, renamed from its conversation, through
  Claude's `set_cwd` (started in home to do it when stopped;
  `docs/notes/move-no-project-1-daemon.md`). The thread owns one
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
* **Skills**: at every start the daemon writes five Claude Code skills, `code-foundry`
  (the entry skill: what the app is, the one rule, which skill to read, and
  `daemon.capabilities` for what exists now; `docs/notes/control-4-capabilities.md`),
  `code-foundry-orchestrate` (delegating work to other threads), `code-foundry-help`
  (how-to questions about the app), `code-foundry-plugin` (building plugins, §10) and
  `code-foundry-pages` (HTML pages that call the app through `/cf/bridge.js`, §13), to
  `<config home>/claude/.claude/skills` (`internal/skills`: static SKILL.md files
  embedded, references rendered from the registry and the settings schema through
  `internal/guide`, `docs/GETTING-STARTED.md` embedded by the `docs` package). Every spawn passes `<config home>/claude` as its first
  `--add-dir`, before the attachments dir, a workspace's managed dir, the other members' checkouts and grants
  (`docs/notes/agent-skills.md`). The entry skill's `reference/scopes.md` says where a standing rule goes:
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
  written; Send, Fork and the MCP and slash command queries alike) and
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
* **Create has two stages** (`setup.go`, `setup_run.go`, `docs/notes/instant-threads-1-daemon.md`).
  The fast one refuses what needs no slow work, with nothing made, then publishes the thread
  with its provisional name and its first message in the timeline. The setup stage names the
  branch while it fetches the bases, makes the worktrees and spawns, recording each step in
  `Thread.Setup` (`threads.setup`). A caller either waits for it (a failure removes the
  thread and what was made, and is the call's error) or passes `background_setup` (a failure
  stays on the thread, `setup failed`). While it runs the thread is STARTING with a
  reservation and busy "setting up"; in worktree mode it has no cwd and no checkouts.
  A background setup has its ways out (`setup_actions.go`,
  `docs/notes/instant-threads-2-actions.md`): `thread.setup.retry` goes on at the step that
  failed, `thread.setup.cancel` stops it and removes what it made (idle `setup cancelled`),
  `thread.setup.discard` undoes the send and gives back the draft. A message sent during it
  queues on the row behind the first prompt; one sent after it failed tries it again. All
  cleanup goes through `rollback`: only what was made, nothing another thread holds, never
  with force, and the project store undoes a `git worktree add` it killed. The GUI shows a
  setup as one timeline row under the first message and in the sidebar's status
  (`lib/threadSetup.ts`, `components/thread/SetupRow.tsx`, `docs/notes/instant-threads-3-gui.md`).
  The new-thread composer's send runs it in the background; the composer's Cancel, Try again and
  Edit are `stores/setupActions.ts` (`docs/notes/instant-threads-4-composer.md`).
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
* **Search** (`search*.go`, migration 0054): an FTS5 trigram index (contentless, one
  document per item id, so a fork's copies are indexed once) over the text that stays
  visible when a turn folds: user messages, assistant text, questions and their answers
  (a registry of extractors by item kind, `searchTexts`). Every item save writes its
  document in the same transaction; a trigger drops a document with the last row holding
  its id; threads from before the index are backfilled at startup in the background.
  `ThreadService.Search` (`thread.search`): smart case, all words, names only under three
  characters; the user's threads by default (the sidebar's, archived included), wider with
  include flags; a hit goes to the oldest thread in scope holding the item; at most the
  5,000 most recently indexed matches are read (`docs/notes/search-3-index.md`).
* **Hidden children** (`sidebar.go`): a thread another thread created is its creator's to
  manage and is not shown in the sidebar while its creator exists (removed, not
  archived, shows it); nothing overrides that, and nothing is stored: `InSidebar` is the
  one rule, which the GUI derives from the thread list. Archiving or removing a thread
  first takes every thread below it along (`ArchiveCascade`, the `descendants-of` walk),
  and `ThreadFilter.archive_cascade_of` lists them for the command's confirmation
  (`docs/notes/hidden-children-1-daemon.md`, `docs/notes/no-sidebar-override-2-daemon.md`).
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
    Args    []ArgSpec         // for CLI flags and palette prompts
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
(`internal/guide`, which also renders the entry skill's `reference/commands.md`): the
conventions and the command index (verb and title per category; a registered verb is listed
unless `Command.NoIndex` marks it), and a topic per category that `code-foundry guide <topic>`
prints in full, `thread` with its own conventions (`docs/notes/guide-command-index.md`).
Inside a thread's Claude process `help` leaves out flags only the GUI or the CLI sets and
puts the common flags on one line; everywhere else it prints the whole text.

Pull request commands: the pull request tab's actions (`pr.merge`, `pr.revert`,
`pr.review.request`, `pr.refresh`; docs/notes/gh-pr-detail.md; `pr.review`, `pr.comment`;
docs/notes/pr-review-submit-1-daemon.md, with the tab's Review menu in
docs/notes/pr-review-submit-2-gui.md) and the thread starters `pr.ask`,
`pr.explain`, `pr.fix.findings`, which pick or create a worktree and type a prompt built
from the pull request (docs/notes/pr-thread-commands.md). Its Code tab is read-only
and has no commands: it reads `GhService.GetPullRequestDiff` and renders it in one
virtualized `@pierre/diffs` CodeView (docs/notes/file-viewer-5-pr-code-tab.md).

The window shell's commands (§14) are families in the same registry, so a key, the palette,
the CLI and a thread's model reach the same op:

| Family | Verbs | Does |
| --- | --- | --- |
| layout | `layout.show` (`--json`), `space.list`, `tab.list` | read the layout: spaces, splits with sizes, panes, tabs, each thread's space and remembered tabs |
| space | `space.new`, `.rename`, `.remove` (`--to` a space or `--archive` its threads; asks first), `.switch` (`--index n`), `.move` | the top bar's spaces |
| pane | `pane.focus` and `.focus.<left/down/up/right>`, `.move.<dir>` (swap), `.move` (beside, into, the outer edge, another space), `.split`, `.close`, `.resize`, `.fullscreen`, `.collapse` | panes; the GUI passes the drawn neighbour as `--to` |
| tab | `tab.focus`, `.move`, `.close`, `.next`, `.previous`, `.rename`, `.auto-name` | tabs; `tab.close` on a thread's tab is `thread.close` |
| thread | `thread.open` (its tab, with its remembered tabs), `thread.close` (from its space, never archived), `thread.space.move`, `thread.new --compose <tab>` | a thread's own tab |
| composer | `composer.new` (New thread in the shell), `composer.draft.start`, `.label`, `.clear`, `.discard`, `.open` | the composer tab and its drafts |
| view.open | `view.open.file`, `.page`, `.diff`, `.pr`, `.gallery`, `.mcp` (`--thread`, `--pane`, `--focus`); `view.thread-diff`; `view.pullrequests`, `view.projects` | open a surface as a tab placed by the rules; the old `view.panel.<item>` names are unlisted aliases for one stable release |
| terminal | `terminal.new` (`--pane`, `--quick`), `.new-free`, `.quick` (`--open`, `--close`, `--height`), `.cycle`, `.reset`, `.rerun` | terminal tabs and the quick terminal |

A verb called from inside a thread (`Context.FromUser` false) gets no default from the
user's focus: it names its space, pane or tab, and runs with `KeepFocus`, so a tab it opens
waits behind the user's focused tab. Verbs that only move the focus (`space.switch`,
`pane.focus`, `view.thread-diff`, `terminal.cycle`, `pane.fullscreen`) refuse it without
`--focus` (`docs/notes/shell-4-commands.md`). `code-foundry guide layout` is their topic.

The default key table is the specification's (`docs/notes/shell-model.md`, Keys), pinned
by `TestShellKeyTable` in Go and `keys/shellKeys.test.ts` in the window; a chord is a
command's `Keybindings` or one of the window's view actions, and `shell/keyPresenters.ts`
says what each verb does in the window (`docs/notes/shell-20-cutover.md`):

| Key | Runs |
| --- | --- |
| cmd+n | `thread.new` (the shell's New thread: focuses the space's empty composer or opens one) |
| cmd+t / cmd+shift+t | `terminal.new` with the focused tab's thread / `terminal.new-free` |
| cmd+j / cmd+shift+j | `terminal.quick` (open and focus, focus, close) / `terminal.cycle` |
| cmd+shift+d / cmd+shift+i | `view.thread-diff` / `view.thread-info` |
| cmd+p / cmd+k | `file.find` / the palette (view action) |
| cmd+w / cmd+shift+w | `tab.close` / `pane.close` (a surface with unsaved work asks first) |
| cmd+[ / cmd+] | `view.back` / `view.forward`: the focus history, across panes and spaces |
| cmd+shift+[ / cmd+shift+] | `tab.previous` / `tab.next` |
| ctrl+cmd+h j k l, arrows; with shift | `pane.focus.<dir>`; `pane.move.<dir>` (both do nothing in full screen) |
| ctrl+cmd+1…9 / cmd+1…9 | `space.switch --index n` / the nth thread of the sidebar (view actions) |
| cmd+shift+enter, escape | `pane.fullscreen`; escape leaves (a window listener) |
| cmd+shift+m | `pane.collapse`: the focused pane to a rail, or open again (nothing in full screen) |
| cmd+shift+a | the Needs-you popup of the next thread that waits (Ember first while it waits) |
| cmd+r / cmd+shift+r | `tab.rename` / `tab.auto-name` (a thread's tab renames or renames again the thread) |
| cmd+b | the sidebar (view action) |

Retired with the panels: cmd+shift+e, cmd+\ and cmd+alt+\; a stale override of a removed
verb in `settings.toml` is reported and dropped, never fatal.

## 8. Frontend

* React 19, Vite, TypeScript strict, Tailwind v4, shadcn/ui, Zustand, `cmdk` for the palette.
* `@xterm/xterm` with `addon-webgl` (falls back to xterm's DOM renderer on context loss), `addon-fit`,
  `addon-web-links`, `addon-search`. Terminal rendering sits behind a small `TerminalRenderer` interface so
  a libghostty-vt-fed grid renderer can replace it later.
* State discipline: sliced Zustand stores, one per daemon service. Streams update slices;
  components subscribe to the narrowest selector. Lists are virtualized. No global
  re-render on daemon events.
* Streams: the GUI holds one `EventService.Watch` stream, one `ThreadService.WatchThread` per
  visible thread view (a thread's tab, the floating composer while it is expanded, the Needs-you
  popup, a plugin's thread node; one stream when several show the same thread) and one
  `TerminalService.Attach` per visible terminal view (a terminal tab, a thread's quick terminal,
  a plugin's terminal node), each only while it is visible. Off screen holds nothing: a tab
  that is not its pane's active tab (a pane mounts only its active tab's body), a pane folded
  to a rail (it mounts no body), a pane behind full screen (not mounted), another space's
  panes, and a quick terminal whose thread's tab is not active. The rest follow
  what is open: `PluginService.WatchSurface` per open plugin surface, `EmberService.WatchBoard`
  while Ember is shown, the dictation streams below, `SearchService`'s `Watch` and `WatchRecent`
  while a search needs them, and `ProjectService.Clone` while the Add Project dialog clones a
  repository. Everything else is a unary call. Every stream is a WebSocket
  (`docs/notes/ws-transport.md`), which leaves WebKit's six HTTP/1.1 connections per origin to the
  unary calls, so nothing rations them. Being visible bounds them, and a plugin view draws each
  thread or terminal once, so its limits (32 and 16) bound what it can hold
  (`docs/notes/ws-remove-slots.md`).
* Dictation (`stores/dictation.ts`, `docs/notes/dictation-4-gui.md`): one shared
  `DictationService.Watch` only while `dictation.enabled` is on (composers hold it) or the
  settings section is on screen, and one `DictationService.Session` while a composer dictates. A phrase lands at the caret of the
  composer that pressed the mic (every composer: thread, new thread, Ember, a pull request
  tab's ask and review), tinted by a ProseMirror decoration, never a mark. The host's hold key
  drives the same session through `dictation.hold`, and the window tells the daemon whether
  a composer can take it (`ComposerTarget`).
* Stream liveness: the daemon sends a `StreamHeartbeat` on every long-lived stream the
  GUI holds after 5 s without other messages (`api.HeartbeatInterval`, mirrored by
  `api/stream.ts` `HEARTBEAT_MS`). A hung or stopped daemon keeps its sockets open and
  says nothing, so `runStream` reconnects an attempt that heartbeated and then went silent
  for three intervals (`StreamSilentError`), a thread shows "catching up…" while its Watch
  retries, and Events' `silent` flag names a socket that brings nothing while pings
  answer. Hiding or showing the window touches no stream. The post-snapshot flushes and
  the resync on show were for fetch in WKWebView, which held a stream's last bytes back,
  and went once every stream was on the tunnel (`docs/notes/ws-stall-workarounds.md`).
* A thread's tab is `components/thread`: a header (the branch chip, the thread info toggle,
  one three-dot menu with Open ▸ and Move to space ▸; `ThreadHeader.tsx`) over a virtualized
  work-log timeline built from the items' structure (`lib/threadTimeline.ts`; text deltas
  re-render only their row), turns that fold under their header the moment they finish (the
  latest too), inline diffs on `components/code` (@pierre/diffs, themed from the app's syntax
  colours by `lib/codeTheme.ts`; `docs/notes/file-viewer-2-code-foundation.md`),
  lowlight-highlighted markdown in the terminal palette, and the
  follow-up composer with a pending permission or question docked into it. Its items live
  in `stores/thread.ts`, fed only by that thread's `ThreadService.WatchThread` (snapshot, then
  seq-ordered events, batched per frame); the EventService `thread` source only carries
  pending requests. Sending, interrupting (the composer's button only; no keybinding),
  answering (`thread.respond`; every pending request docks, oldest first, answerable by
  click or 1/2/3) and the model / mode / effort pickers are the `thread.*` commands
  (`docs/notes/rendered-threads-2-gui.md`, `docs/notes/rendered-threads-3-interaction.md`).
  The follow-up composer's `/` card offers the running process's slash commands from the
  thread's log (Claude Code's own in a last "Claude Code" group, inserted as plain text),
  and the ListSkills scan while there are none (`docs/notes/slash-commands-2-gui.md`).
  Every fenced code block and Bash command has Copy; a shell block in Claude's reply also
  has Run in terminal, a new terminal tab linked to the thread through `terminal.new
  --run` (the daemon types the line once the shell has printed its prompt;
  `docs/notes/code-block-actions.md`). Text selected in one of Claude's answers can be
  cited into the composer with a comment: an amber `cf-cite://` chip whose body the draft
  keeps, sent as a self-contained `[Assistant quote](cf-cite://v1/…)` link the bubble
  reads back, painted over the answer with the CSS Custom Highlight API; GUI only, no
  command (`components/thread/cite`, `docs/notes/citations.md`). cmd+f (`thread.find`, with
  cmd+g / cmd+shift+g) opens a find bar over the card's column: matches counted from the
  items (messages, Claude's rendered text, answered questions), painted the same way where
  rows render, ticks along the scrollbar, a folded question opened and put back
  (`components/thread/find`, `docs/notes/search-2-thread-find.md`). With the keyboard in a
  terminal the same chords are `terminal.find` and its siblings: the same bar over the
  terminal, searching its scrollback, or only the screen in the alternate screen (vim, less)
  (`terminal/find.ts`, `docs/notes/terminal-find.md`).
* Only visible views are watched or attached: one WatchThread per thread on screen
  (`stores/thread.ts` `startThreadWatch` counts its holders), one Attach per terminal
  view (a plugin terminal shown in a tab is not attached in its node too; the node steps
  aside). Switching a pane's tab, folding a pane or switching space ends the old stream and
  opens the new one. Background
  threads cost nothing in the frontend. Watching is also how the daemon knows a thread
  is being looked at: while a thread has a WatchThread subscriber and a GUI window is
  visible and key (attended), finished turns count as seen (`docs/notes/alerts-foreground.md`).
* The window (`App.tsx`, `components/shell`; the specification is
  `docs/notes/shell-model.md`, what was built `docs/notes/shell-build.md`). The **top bar**
  (`TopBar.tsx`) spans the window above the sidebar, not aligned to it, and is its drag band:
  the traffic-light gutter, the app name, the sidebar toggle, the Needs-you control while the
  sidebar is collapsed, back and forward, the **space tabs** (`SpaceTabs.tsx`: a glyph drawn
  from the space's own tree, its name, how many of its threads need the user; click, rename in
  place, drag to reorder, Remove space… through a dialog that moves or archives its threads)
  and "+". Under it, the sidebar and the current space's **pane grid** (`PaneGrid.tsx`):
  panes placed from the layout's tree, 12 px gutters that drag (`pane.resize`) and take the
  keyboard. A pane (`PaneView.tsx`) is its tab strip (`PaneTabStrip.tsx`: the tab is the
  title; tabs shorten, then go icon-only, `geometry/tabFit.ts`, with a tooltip only for a cut
  name; the attention dot on a thread's icon; "+" at the end, `PanePlusMenu.tsx`, a menu of
  surfaces; collapse and full screen at the right), the quiet row under the strip that names a linked
  tab's thread and links back (`LinkedRow.tsx`), and the active tab's body only. A space with
  no pane shows the composer (`EmptySpace.tsx`).
* The layout slice (`stores/layout.ts`) is the daemon's layout and nothing else: a snapshot
  then deltas by rev (a gap reads it again with `Get`), flattened into spaces, trees, panes,
  tabs and thread records that keep their object identity across commits, so a pane
  re-renders only when it changed. Only `focusTab` and `focusPane` apply before the daemon
  answers (an overlay until the commit at their rev); every other change is a layout verb
  (`shell/commands.ts`) and waits for its event (`docs/notes/shell-10-layout-slice.md`). What
  depends on the drawn frame is window state, never stored (`stores/shellView.ts`): the
  frame, rails, full screen, the floating composer, focus requests. The grid reports its box
  with `SetViewport` (`shell/viewport.ts`).
* Geometry (`shell/geometry`, pure; `docs/notes/shell-9-geometry.md`): `plainRects` equals
  the daemon's `Rects` to the px (shared fixtures); `frameRects` holds each pane at its
  minimum (480 × 400 whatever its tabs, 300 × 220 for a pane of terminals only; Go's
  `internal/layout/fit.go` has the same numbers); `treeFits` says whether a tree fits with no
  automatic fold, the daemon's `layout.Fits` (shared `fits.json`): an action that would add an
  open pane or raise a pane's minimum is offered only when the result fits, in the daemon's ops
  and placement and in the window's drag targets and "+" menu (`shell/drag/room.ts`;
  `docs/notes/shell-25f-sizes.md`); `rails.ts`
  folds the panes that cannot keep theirs into 36 px rails of tab icons (panes without a
  thread tab first, least recently focused first; never the focused pane or its thread's),
  computed per frame and never stored, so a larger window unfolds them; a pane the user
  collapsed (`pane.collapse`, its `collapsed` mark stored with the pane) is always a rail and
  never in that order (`docs/notes/shell-25d-collapse.md`); `neighbour` is the pane a direction
  key goes to. A divider stops at the minimums as drawn, starts from what is drawn, and its
  cursor says which ways it can still move (`shell/resize.ts`).
* Surfaces: a tab's body comes from the shell's surface registry (`shell/surfaces`): thread,
  compose, prs, projects, terminal, and the panel surfaces (file, diff, pullrequest, mcp,
  gallery, ember.board, `plugin.*`), which draw the `src/surfaces` specs inside a scroll
  box that is also the pane's focus root and dispatches the surface's own keys
  (`surfaces/panel.ts`). Kinds and identity are the daemon's table, ported once
  (`shell/identity.ts`, pinned to `internal/layout/testdata/kinds.json` and
  `identity.json`). Surfaces reach their tabs only through the **host seam** (`shell/host.ts`,
  `hostShell.ts`): `openTab` (a user's open takes the focus; `behind` keeps a new tab behind
  the editor in use), `setTabParams` and `retitleTab` (one ordered queue per tab), `tabPlace`
  / `useTabPlace` (a thread's linked tabs in its space), `subscribeTabs`. A linked tab's body
  acts for its thread (`shell/panelKeyContext.ts`), an unlinked one for what the window has
  focused (`docs/notes/shell-8-host-seam.md`, `shell-gaps-b-surfaces.md`,
  `shell-gaps-c-identity.md`).
* Focus: the layout holds which pane and tab have the focus; the window moves the keyboard
  after it (`requestPaneFocus`: a thread's prompt, a composer, a page's `[data-focus-root]`).
  The selection bridge (`stores/selectionBridge.ts`) writes `ui.selection` from the current
  space's focused tab for code that reads one selection, and routes `select()` to
  `thread.open --focus`. The focus history (`stores/focusHistory.ts`: space, pane and tab per
  entry, per window, 100 kept) is cmd+[ and cmd+]. The command context's terminal is the
  focused terminal tab's or the quick terminal with the keyboard
  (`docs/notes/shell-gaps-a-focus.md`).
* Drag (`shell/drag`, `ShellDnd.tsx`): any tab, a pane by its strip's free space, a sidebar
  row. Hit-testing is geometry over the drawn frame (the grid's outer band, strips, a pane's
  edge bands and middle, a rail as one target, a space tab), and the preview replays the
  daemon's own tree edit and lays it out, so it is the rectangle that lands. A drop is one
  `tab.move` or `pane.move` (a row: `thread.open` with its place); on a space tab a
  thread's tab runs `thread.space.move`, and a pane `pane.move --space`, which moves it whole
  with its threads and their linked tabs (`docs/notes/shell-14-drag.md`,
  `shell-14b-outer-edge-size.md`, `shell-15-spaces.md`).
* Full screen (`shell/fullscreen.ts`, `pane.fullscreen`): the space's focused pane over the
  whole grid, the others unmounted; the top bar and the sidebar stay and the direction keys do
  nothing. Over a linked tab the thread's own composer floats (`FloatingComposer.tsx`): a pill
  that holds nothing, expanded by a click or ⌘L with the thread's WatchThread, its draft the
  thread's (`docs/notes/shell-19-rails-fullscreen.md`).
* Terminals (`docs/notes/shell-13-terminals.md`): a terminal tab (`TerminalTab.tsx`) is named
  by what runs (`lib/terminalName.ts`: a manual name, else the foreground command, else
  `<shell> · <folder>`) with an icon by program; when its thread is elsewhere the linked row
  says so with Reset; a tab a snooze restored shows the last command and Run again, never run
  by itself. The quick terminal (`QuickTerminal.tsx`) sits under a thread's conversation and
  composer, pushing them up while the composer and 120 px of conversation fit, else over the
  bottom of the pane.
* The first draw (`shell/legacyImport.ts`, `ShellNotice.tsx`): the window waits for the
  layout; while it says `legacy_imported` is false, it sends the classic window's stored
  `code-foundry.panel` and `code-foundry.bottom` values to `ImportLegacy` once and draws from
  the answer; a failure offers Try again and Open without them. A daemon with no layout
  opens the update dialog (`SHELL_SINCE`, `lib/update.ts`; `docs/notes/shell-20-cutover.md`).
* Sidebar (`components/sidebar/shell`; `docs/notes/shell-16-sidebar.md`): New thread and
  search, then **Needs you** (the user's own threads that wait on them: a permission, a
  question, a plan, a woken snooze, a plugin's flag; from every space or this one,
  `sidebar.needs_scope`, switched by one pill), **Active** (this space's pinned threads, its
  composer drafts, then errors and finished turns, then idle ones), and the collapsible footers
  Working, Snoozed and Archived (Archived lists every space's), scrolling on its own, with a
  status row at its foot. A thread row is three lines: the project and the status (the snooze
  and archive controls on hover), the title up to two lines, the branch with its pull request
  tag and counts. A click opens the thread's tab in the focused pane, or focuses it; a row
  drags into the grid or onto a space tab; its menu has Open ▸ (the thread's surfaces) and
  Move to space ▸. A Needs-you row's hover card shows the whole ask (a permission's Allow and
  Deny once the request is known whole), its title opens a popup with the thread's
  conversation and today's ask card, and a pane too short for the card shows the ask as one
  line above the composer (`components/needs`, `docs/notes/shell-17-needs-you.md`). A thread
  another thread created is hidden from every sidebar list, the keyboard order and the
  attention counts while its creator exists (no setting, no override; an orphan whose creator
  was removed is listed), one rule in `lib/inSidebar.ts`:
  `docs/notes/no-sidebar-override-1-gui.md`; nothing in the GUI shows whether a thread's
  Claude runs: its composer always sends, starting looks like working, a stopped thread
  reads as its status: `docs/notes/hide-connection-state.md`.
* Pages are tabs, one of each per space (`view.pullrequests`, `view.projects`, a pane's "+"):
  the Pull Requests page, and the Projects tab, whose location is in its params: an index of
  projects and workspaces by last activity that drills into a project's page (its checkouts
  table and details) or a workspace's page (`docs/notes/projects-redesign-1-index.md`); a
  workspace's page: its projects with where new threads start (Start here, Remove, Add
  project), its threads with each member's checkout for the thread's branch, its instructions
  file (View as a File tab, Write/Edit instructions starting or steering a thread in the
  workspace's folder), skills and folder, Open in Finder, Rename (in place) and Remove; a New
  workspace dialog: `docs/notes/workspaces-v2-4-projects-page.md`,
  `docs/notes/projects-redesign-3-workspace-page.md`.
* The composer is a tab: at most one empty composer per space (New thread focuses it or opens
  one in the focused pane); typing makes it a draft with its own identity, listed in the
  sidebar and kept with its text through a closed tab and a reload
  (`shell/composerDrafts.ts`); sending turns the tab into the thread's (`thread.new --compose`).
  It holds a project set picked in the heading (a workspace row selects its members and the
  reference, projects toggle), chips by project id, Work in, a Runs in picker for the primary
  (a project or the workspace's folder), collision hints under the chips, and "New thread on
  this branch" (`thread.new-like`) prefilled from a thread so only the prompt is typed:
  `docs/notes/workspaces-v2-3-composer.md`.
* The panel surfaces, each a tab placed beside its thread by the daemon's rules
  (`view.open.*`; `src/surfaces`, `docs/notes/side-panel.md` for their history): File (one
  file read from disk as code, rendered markdown or live HTML in a sandboxed frame served by
  the daemon's `/preview/<grant>/` route (`internal/preview`,
  `docs/notes/html-preview-interactive.md`), or an image; opened from the Diff tab's Open file,
  path chips in Claude's markdown and file tool rows (`docs/notes/file-viewer-4-chips.md`) and
  the file finder, one tab per path; `docs/notes/file-viewer-3-tabs.md`), Diff (two sources of
  one checkout, file by file, with the file list as a rail or on top by the tab's width; one
  tab per thread and checkout, plus one per thread that frames it with `view.open.diff`'s
  `--title`, `--note`, `--path` or `--hide`, the checkout's staying the user's; `--hide` is the
  only way to reduce the controls, and the tab always offers them back;
  `docs/notes/diff-viewer-2.md`, `docs/notes/diff-viewer-3.md`), Pull request (one tab per pull
  request), whose menu starts threads about it through `pr.ask`, `pr.explain` and
  `pr.fix.findings`, MCP (the thread's MCP servers, one card each with status, error, tools
  and Reconnect; opened by the card's MCP row and `view.open.mcp`; `docs/notes/mcp-panel.md`)
  and Gallery (a set of images a thread shows, a grid that opens one over a filmstrip; only
  `view.open.gallery` opens it, one tab per title; `docs/notes/gallery-surface.md`). The
  Worktree, Workspace, Linked PRs, Usage, Agents and Threads surfaces are gone: the thread
  info card shows what they did (`docs/notes/thread-info-card.md`). A depth-1 subagent row
  or a strip name above the composer (background runs) shows that run read-only in the
  thread's tab in its place, the thread staying focused on its one WatchThread:
  `thread.agent.open`, back up by Escape or `thread.agent.up`;
  `docs/notes/subagent-view.md`.
* Every palette command is reachable without the mouse, and common ones also have buttons
  that invoke the same registry command. The palette lists the commands the daemon does not
  mark `NoPalette` (`Command.no_palette`): queries whose only output is a text toast,
  verbs for the model or the CLI to drive the app, Ember's task board, and verbs whose
  required arg is an opaque id a page offers on the right row;
  `internal/command/palette_test.go` keeps that list (`docs/notes/palette-no-palette.md`).
  Chords are listed only in the palette and the Keyboard Shortcuts overlay
  (`docs/notes/phase3-ui-buttons.md`), plus the hint on the sidebar's New thread button. The
  native app menu's Settings…, Thread and Help items run commands in the window through one
  host event and carry no key equivalents (`docs/notes/onboarding-1-entry-points.md`). The
  help overlay's first tab is the getting started guide, `docs/GETTING-STARTED.md` bundled at
  build time (and shipped to threads in the `code-foundry-help` skill); keep every label and
  chord it names in step with the app (`docs/notes/onboarding-2-guide.md`).
* Ember in the GUI (`docs/notes/ember-3-gui.md`): while `ember.enabled` is on and the
  resident thread exists, a pinned row above New thread (the flame glyph,
  `components/ember/Flame.tsx`, in its idle, thinking, working or attention state; "Ember"
  and a status line; the thread list's arrows reach it) opens Ember's chat as a tab in the
  focused pane. The chat is the resident thread's own WatchThread and timeline list (ThreadPane routes a
  resident `ember` thread to `components/ember/EmberPane.tsx`) with its own rows
  (`lib/ember.ts` `buildEmberRows`): the user's messages and Ember's text show, and every
  run of work between them (tool calls, subagents, wakes) folds into one "Worked for" row;
  task links (`[Title](cf-task://t-…)`) render as pointer lines that open the Board
  surface (`surfaces/ember.ts`, a tab linked to Ember's thread) at the task. One shared
  `EmberService.WatchBoard` (`stores/ember.ts`) feeds the row, the chat header and the
  Board while any of them shows (inline for the row alone, core with the chat or the
  Board). cmd+shift+a visits Ember first while it waits, then the Needs-you popups; the
  window title, the Dock badge, Needs you and the space tabs' counts leave it out.
* Skills page (`docs/notes/skills-page-redesign.md`, over `docs/notes/skills-4-gui.md`):
  Settings → Skills is a GUI page (`components/settings/guiPages.ts`,
  `components/skill/settings`) on the shared catalog layout (`components/settings/catalog`)
  over `stores/skill.ts`, held open (`openSkillMarketplace`) while it shows. One virtualized
  list (`VirtualStack`) holds the installed rows, grouped Needs you (an update, setup to run
  or a missing folder), Enabled and Disabled, then the marketplace's: the installed groups
  filter in the client, the marketplace is the daemon's search (150 ms debounce, tier and
  kind chips, at most 200 hits). Registries is a dialog (`RegistriesDialog.tsx`). A row's
  switch enables or disables at once; Uninstall and Remove confirm in the page's dialog and
  answer the daemon's confirm for that call (`stores/skillConfirm.ts`). A GUI-only page lists
  its sections, and the settings search finds them by name (`searchGuiPages`): a hit opens
  the page at the section.

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
  the local default and the base as typed, not fetched (checking out a branch only
  origin has still fetches it; `docs/notes/base-from-origin.md`,
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
  per-path snapshot pointers. The backstop poll (a reconcile: worktrees, metadata and
  the stream's paths re-read, then every status, so an event that is late, dropped or
  never sent leaves nothing stale past one interval; `docs/notes/project-watcher-tests.md`)
  and the background fetch run each project on a live tier (a worktree with a live thread, or a detail asked for in the
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
mostly by agents, that the daemon runs and that contribute commands, surfaces
(tabs), thread flags, a share of every new thread's environment, and Claude threads and
terminals of their own. Design: `docs/sketches/plugins/` (`DECISIONS.md` wins); what was
built: `docs/notes/plugins-1-core.md` through `plugins-14-flag-guidance.md`.

* **Package.** A folder `$CONFIG/plugins/<name>` with a `plugin.json` (name, version,
  protocol, `exec`, permissions, commands, surfaces) and the executable. `plugin dev`
  links a folder there (`--watch`: the daemon rebuilds and restarts it on every change);
  registry installs unpack a release tarball there. A
  plugin found on disk is disabled until the user consents to its permissions
  (`commands` globs, `events` sources, `threadStatus`, `sessionEnv`, `secrets`,
  `threads`, `terminals`, `api`: the registry entry's keys); more permissions on an
  update disable it again until they consent.
* **Store** (`internal/store/plugin`): discovery and the `plugins` table, one actor per
  enabled plugin (start with cwd = package folder and a minimal env, `initialize`
  within 5 s, ping every 30 s, backoff 1 s to 60 s, failed after 5 crashes in 10 min,
  dev plugins never fail), logs (`logs/plugins/<name>.log` plus a 1,000-line tail), the
  Keychain secrets (`security`, service `code-foundry-plugin`), and the dev watch
  (`devwatch.go`, `docs/notes/plugin-dev-watch.md`): a goroutine per watched dev plugin
  polls its folder every 500 ms (stat, hash only on a size or mtime change, act when two
  scans agree; no FSEvents, which is the project store's), runs `$SHELL -lc <build>` with
  the plugin's minimal env and logs it as source `build`, then `Restart`s; `DevSettle`
  runs first in `GetSurface` and `Act`, so a read after an edit sees the rebuild or the
  build's failure. Plugin → host methods
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
  carries the acting tab's context (its thread when the tab is linked to one).
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
  (schema, limits, keys, URLs, the commands a view may run, secrets), re-encoded
  (unknown fields dropped, so an older daemon shows a newer table cell, a meter, as empty),
  versioned and coalesced per watcher; log nodes take appends. `PluginService.WatchSurface`,
  `GetSurface` and `Act` serve them; an act names an element of a recent version and the
  daemon fills in the rest. `ShotSurface` returns a PNG the app's host draws (§4
  WatchShots), which the CLI writes; with no app open it fails and never starts one. A form's secret input with `store` goes to the Keychain, and
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
  `pluginsdk/plugintest` (a fake host). Releases are tagged `pluginsdk/vX.Y.Z`; plugin
  repositories `go get` the tag on the commit the daemon was built from, else that commit
  (`skills.SDKPin`).
* **GUI**: plugin surfaces are a generic tab kind (`plugin.<name>.<surface>`), linked to a
  thread when thread-scoped and placed by the daemon's rules, as wide as their pane (at
  least 480 px, the whole grid in full screen), available exactly when their show command
  is (which opens the tab from the window through a ShowView `panel.<kind>`); one
  renderer component per node kind, drawn with the app's own components (no HTML from
  plugins, no filled buttons, neutral header icon, emerald only for `ok`); one
  `WatchSurface` per visible surface; host-side `command`, `openUrl` and `copy`; form
  drafts per instance and tab; the consent dialog is `plugin.enable`'s confirm; `shot.html`
  (`src/shot`) draws one surface alone in the published theme and reports its height when
  ready, for `plugin surface --shot` (`docs/notes/plugin-surface-shot-page.md`); the Wails
  host loads it in a window it orders in off every display for each shot, snapshots the
  webview and publishes the PNG (`gui/shot.go`, `docs/notes/plugin-surface-shot-host.md`).
* **Skill.** `code-foundry-plugin` (`internal/skills`) teaches an agent the loop:
  `plugin new` (`internal/pluginscaffold`: the embedded `plugins/examples/minimal`
  renamed, its module made and the SDK fetched with `go get` at this daemon's
  pin), `plugin dev`, `plugin logs`, `plugin surface` / `plugin
  act`, plugintest, release tarballs (`make release`, one script for `release.yml` on
  the runner the user names and for a release by hand when they have none), the
  registry pull request. Its CLI and host
  command references are rendered from the registry at start; reserved names, event
  sources, host facts and view limits are filled in from the code.
* **Registry**: `alexwaumann/code-foundry-plugins` serves `index.json` built from
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
only in a visible `kind=setup` terminal, shown as a tab (`skill.setup`), whose exit 0 the
daemon records. The `skill.*` commands drive it. `SkillService`
(`docs/notes/skills-3-api.md`) only reads (`Search`, `Installed`, `Registries`; the
EventService skill source carries the epoch); the GUI's `stores/skill.ts` re-reads
on a new epoch while the page is open and runs the `skill.*` commands for every action.

## 11. Conventions

* Features add files, not edits. Registries over switch statements. Messages owned by the
  emitter.
* Pure functions with table tests for anything with branches: stream status, layout,
  command availability, snapshot serialization.
* A store's fake lives in `<store>/<store>test` (every store but ember, memory, search and
  usertheme has one).
* Go 1.26 (required by the libghostty-vt bindings). `context.Context` first, errors wrapped with `%w`, no panics outside `main`.
* Logging: `log/slog`, JSON to `$CONFIG/logs/daemon.log`, text to stderr in dev.
* Frontend never imports generated protobuf types outside `src/api/`; it maps to view
  models at the boundary.

## 12. Non-goals for v1

* Cross-platform. macOS only.
* Keeping PTYs alive across daemon restarts.
* Remote daemons. The protocol allows it; nothing implements it.
* A custom terminal renderer. xterm.js is the renderer until measured otherwise.

## 13. Pages

HTML pages the model shows (`view.inline` in the conversation, `view.open.page` and a File
tab's preview) run in sandboxed frames that never touch the API
(`docs/notes/bridge-1-daemon.md`).

* **The pages listener** (`internal/daemon/pages.go`): a third loopback listener, its port
  kept in `pages.port` so a page's origin survives restarts. It serves only what a page loads
  without a credential: `/preview/<grant>/` (`internal/preview`: a grant from
  `FilesystemService.PreviewFile`, bound to one directory tree or one file, is the URL's
  credential) and `/cf/`. Nothing behind the token is served there, and the API listener's
  CORS refuses the pages origin, so a page holding a leaked token still cannot call the API.
* **`/cf/bridge.js`** (`internal/bridge`) gives a page `window.cf`: run the registry verbs its
  thread may run, subscribe to daemon events, read the theme, `cf.storage` and `cf.fetch`.
  A page reads no terminal's command lines: the read verbs and the `terminal` source leave
  them out for it (`internal/command/command_lines.go`, `stores/bridgeSources.ts`).
  Every call is a `postMessage` to the GUI (`lib/bridge.ts`, `stores/bridgeHost.ts`), which
  answers only its own frame and invokes the command with its own token
  (`docs/notes/bridge-2-gui.md`).
* **The page library** (`internal/pagelib`, `docs/notes/page-library.md`): React as ES
  modules, `@cf/ui` (the app's `components/ui`), `@cf/icons` (lucide-react), the TSX loader
  `/cf/jsx.js` and the Tailwind browser runtime with the app's theme, so a page needs no
  build step. `dist/` is built from the GUI's sources by `make pagelib` (which `make gen`
  runs) and committed; `make check` rebuilds it and fails on a diff.
* **The theme**: the GUI publishes its active theme and resolved slots with
  `UiService.PublishTheme`; the pages listener serves them as `/cf/theme.css` and
  `/cf/theme.json` (`internal/theme`, `docs/notes/theme-css-route.md`).
* **What a frame cannot do**: the frame has no window to open, no dialog and no download, and
  a site loaded in it cannot sign in. The daemon writes `internal/preview/frame.js` into every
  HTML document a frame navigates to: a clicked link to another site, `window.open` and a GET
  form go to the browser (`view.open.url`); `alert`, `confirm`, `prompt`, downloads, a POST form
  and a script's `location` to another site are reported in the page's error badge
  (`docs/notes/page-frame-links.md`). A frame that went to another site anyway is covered with
  Reload, and the bridge follows a page to its own other files (`docs/notes/leftovers-pages.md`). A page saves a file with `file.export`
  instead, into its thread's checkout, after the user allows it (`docs/notes/page-save.md`).
* **Page storage**: WebKit keeps a cross-site frame's localStorage for the session only, so
  `cf.storage` writes go through the GUI to `ThreadService.SetPageStorage`, one JSON file per
  thread (at most 256 KiB), handed back to a page as it loads (`PageStorage`;
  `docs/notes/bridge-fix-storage.md`).
* **Proxy fetch**: `cf.fetch` is `ThreadService.ProxyFetch` (`internal/proxyfetch`): the daemon
  makes the request, so a page reaches an API that does not allow the pages origin. No
  cookies, Origin or Code Foundry token; never to loopback, link-local or the daemon's own
  ports (`docs/notes/bridge-fetch.md`).
* `ThreadService.ShowHtml` and `ShowTheme` put a page or a theme card in the conversation
  (`docs/notes/inline-html.md`, `docs/notes/theme-model-flow.md`); the `code-foundry-pages`
  skill teaches the model to write pages for the bridge and the library.

## 14. Layout: spaces, panes and tabs

The window shell's state lives in the daemon, so the CLI and a thread's model can read and
change the layout a key press changes (`docs/notes/shell-model.md` is the specification,
`docs/notes/shell-build.md` the summary of the build and its step notes). The daemon is the
only writer; the GUI renders the published layout, sends commands, and keeps to itself only
what depends on the drawn frame (rails, full screen, tab fitting, drag targets, the keyboard).

* **The model** (`internal/layout`, pure, no I/O): a `State` of spaces in order, the current
  space and the default one (a thread with no record lives there); a `Space` is a name, a
  tree of `Node`s (a pane with its tabs, active tab and whether the user collapsed it, or a split with a direction, kids and
  sizes that sum to 1), its focused pane, its MRU of tabs and its composer drafts; a `Tab` is
  a kind, an optional thread link, params and a title; each thread has a record (its space,
  its remembered tabs, its quick terminal's open state and height, its last tab per kind).
  Every change is an op (`{"op": "move_tab", ...}`, a registry of structs by JSON name):
  `Apply` runs it on a copy, normalises, checks the normal form, and returns the state it was
  given on any error. The ops: the tree (`add_tab`, `split_pane`, `move_tab`, `move_pane`,
  `merge_pane`, `swap_pane`, `close_tab`, `close_pane`, `set_sizes`, `focus_tab`,
  `focus_pane`, `set_tab_params`, `rename_tab`), spaces (`new_space`, `rename_space`,
  `remove_space`, `reorder_spaces`, `switch_space`), placement and threads (`open_surface`,
  `open_thread`, `close_thread`, `move_thread`, `archive_thread`, `snooze_thread`), drafts
  (`new_thread`, `start_draft`, `label_draft`, `clear_draft`, `discard_draft`, `open_draft`)
  and terminals (`set_quick`, `replace_terminal`, `drop_terminal`). `testdata/ops/*.json` pins
  each op case by case; the GUI's geometry, drag preview and the mock daemon run the same
  files (`docs/notes/shell-1-layout-model.md`).
* **Identity** (`identity.go`, a table, not a switch): each kind says what makes two tabs the
  same (a diff per thread and checkout, plus one per asker and title; a file per path; a pull
  request per slug and number; a terminal per terminal; one composer per space, a draft per
  id; one Pull Requests and one Projects tab per space), whether it links to a thread, and
  its default size. Opening a tab whose identity is open uses the open one. `kinds.json` and
  `identity.json` hold the GUI's port to it (`docs/notes/shell-gaps-c-identity.md`).
* **Placement** (`place.go`): a linked surface opened by a key, a menu, the palette or a model
  goes, in order, to the open tab; a pane holding this thread's linked tabs; a pane beside
  the thread's holding linked tabs (right, left, below, above); any pane holding them; a new
  pane right of the thread's at the kind's size when the conversation keeps 480 px; else the
  thread's own pane. A closed thread's surface goes to the focused pane, and so does a
  thread's own tab. A joined pane is never resized. Placement measures in the pane area the
  window reports (`SetViewport`; the newest report of a visible window, else 1180 × 820).
  `Result.rule` says which rule placed it (`docs/notes/shell-2-placement.md`).
* **A thread's tabs**: `close_thread` closes its linked tabs in its space and remembers where
  each was; `open_thread` puts them back into their old panes when the thread is back in its
  old pane, else places them fresh beside it. Moving a thread takes its linked tabs;
  removing a space closes each of its threads as `close_thread` does, so their linked tabs
  join their sets and their terminals keep running; archiving closes them everywhere and
  ends its terminals; snoozing closes them, ends its terminals and remembers them as fresh
  shells with the command each ran (a terminal tab in another space with that space, to go
  back there). An archived thread lives in no space: `open_thread` with `archived` opens it
  in the current space, and with a pane and an index or an edge it opens at a drop's place
  in one op. **Smart swap**
  (`swap.go`, setting `layout.smart_swap`): when a thread tab gains the focus, every pane
  whose active tab is another thread's linked surface of a kind this thread also has open in
  that pane switches to it.
* **Focus from a thread**: `Options.KeepFocus` runs any op and puts back the user's current
  space, focused tabs and MRU, so a model's tab waits behind the user's focused tab. The
  commands use it for every call not made by the user in person (§7).
* **The store** (`internal/store/layout`): one mutex, `core.Apply` on the current state, then
  write, swap the snapshot, publish; an op that changes nothing is no commit. SQLite tables
  `layout_spaces` (a JSON document per space), `layout_threads` (one per thread) and
  `layout_meta` (`rev`, `current_space`, `default_space`, `legacy_import`). A structural
  commit is written before it is published; a focus-only one is published at once and written
  within a second, by the next structural commit or at `Close`. Rows that do not decode are
  repaired at load and logged once. Rows a newer build wrote (a newer version, a tab kind or
  node type this build does not know) are left as they are: the store shows what it
  understands and writes nothing (`Snapshot.Newer`, `Layout.newer`; the window says so in a
  line under the grid). The rev survives restarts; the event source's epoch tells
  a client to take the snapshot again. `layouttest` is the fake with the real ops
  (`docs/notes/shell-3-layout-store.md`).
* **The event source and the service**: EventService's `layout` source sends the snapshot,
  then a delta per commit (whole changed spaces and thread records, always the order and the
  current and default space) with the rev and the client id that applied it. The bus event
  also carries the op and its result for the daemon's own glue; clients never see them.
  `LayoutService` (§4) converts each `LayoutOp` case through a registry of converters
  (`internal/api/layout_ops*.go`); its errors map one to one (not found, invalid argument,
  already exists, failed precondition).
* **The glue** (`internal/daemon/layout.go`), so the store never imports the thread or
  terminal stores: a new thread joins its creator's space or the current one (a plugin's
  stays in the default space); an unarchived one joins the current space unless its tab is
  open (opened while archived, it lives there); archive, snooze and
  removal reach the layout through the thread store's `ShellsGoing` hook, before the shells
  go, so a snooze can record each terminal's foreground or last command; a commit's closed
  terminal tabs end their terminals (shells and action runs, never a plugin's), while tabs
  closed with their thread keep running; a removed terminal closes its tab; a reset
  terminal's tab follows the shell that `replaces` it; opening a snoozed thread starts a
  fresh shell for each restored terminal tab; a sweep at start and every minute drops what
  the layout holds of terminals that are gone (no terminal survives a daemon restart); and
  when the bus dropped a layout or thread event for it, the glue catches up from the stores'
  snapshots (`docs/notes/shell-6-lifecycle.md`, `docs/notes/shell-review-fixes-daemon.md`).
* **The first-load import** (`internal/layout/legacy.go`, `legacy_panel.go`,
  `internal/daemon/layout_import.go`): once per home, the first window sends the classic
  window's stored side panel and bottom panel values; the daemon runs a Go port of the old
  store's migrations (pinned to 57 captured cases), and each live thread's side panel tabs
  and terminals become its remembered set, its oldest running shell its quick terminal
  (labelled `slot=quick`). No thread is opened and no terminal ends: the first space stays
  empty and shows the composer. Only terminals alive at import time come over; an update's
  daemon restart has already ended the old ones. `legacy_import` in `layout_meta` makes it
  run once (`docs/notes/shell-18-legacy-import.md`, `docs/notes/shell-20-cutover.md`).
* **The mock daemon** (`gui/frontend/mock/layout.ts`, `layoutVerbs.ts`) ports the tree,
  space and draft ops and runs them against the same JSON cases; placement rules 2 to 6,
  restore and smart swap are tested in Go only, and the mock simplifies them.
