# Build plan

Phases are ordered by dependency. Steps inside a phase run in parallel, each on its own
branch off `main`, each landing through a PR. A step is done when it builds, its tests
pass, `make check` is green, and its doc note is written.

## Status (2026-10-08)

Phases 0–3 are done and merged on `main`. Each step's note is in `docs/notes/`.

* **Phase 0** done: daemon with socket + token listeners, bus, client auto-start, CLI, Wails/React shell, CI (`phase0.md`).
* **Phase 1** done: terminal (libghostty-vt actors), projects (then called repos), GitHub, command registry and GUI shell (`phase1a`–`phase1e`).
* **Phase 2** done: threads (then called sessions), status detection, thread GUI, one EventService stream; memory gate in `docs/perf.md` (`phase2a`–`phase2c`, `phase2-integration.md`).
* **Phase 3** done: Pull Requests page and worktree overview, settings/help/confirm, git operations, packaging and updater (`phase3a`–`phase3d`, `phase3-integration.md`).
* **New thread composer** done (2026-10-09): project picker + in-pane composer, positional prompt, permission mode, `cf/<slug>` worktrees, image attachments, opus/high defaults, "thread" copy (`new-thread-composer.md`).
* **Side panel + PR surface** done: per-selection side panel with a surface registry, the Pull request surface (summary, timeline, reviewers, refresh, revert), and its menu starting `pr.ask` / `pr.explain` / `pr.fix.findings` threads (`side-panel.md`, `gh-pr-detail.md`, `pr-thread-commands.md`).
* **Natural thread names** done (2026-10-13): the namer asks for a 3–6 word sentence-case title, cleaned to one line; `cf/<slug>` branches slugify it; forks are "<parent> (fork)"; old slug names stay (`natural-thread-names.md`).
* **Rename session to thread** done (2026-10-16): one `ThreadService`, `internal/store/thread`, `thread.*` commands and CLI verbs, `threads.*` settings (legacy keys rewritten on load), `CODE_FOUNDRY_THREAD` / `--context-thread`, migration 0022 renames the tables, frontend modules and test ids (`rename-session-to-thread.md`).
* **Rename repo to project** done (2026-10-17): `ProjectService`, `internal/store/project` (and `newproject` for create/publish), `project.*` commands and CLI verbs with a new `project list`, `--project` / `--context-project`, `projects.*` settings (legacy keys rewritten on load), migration 0026 renames the tables and `repo_id` columns, frontend modules and saved state (`rename-repo-to-project.md`).
* **Skills marketplace** in progress (2026-10-20, four PRs): PR 1 (the `internal/store/skill` store: marketplaces from `claude plugin marketplace list`, checkouts read into plugin and skill entries, search, installed state, migration 0038, hourly refresh) done (`skills-1-registry.md`); PR 2 (install, enable, disable, update, uninstall, remove, setup in the store; the nine `skill.*` commands; `kind=setup` terminals) done (`skills-2-lifecycle.md`); PR 3 API, PR 4 GUI pending.

### Multi-repo workspaces: the five steps are built

Design settled 2026-10-09 (`docs/notes/workspaces-handoff.md`); all five steps of its
build order are built, each with a note: `workspaces-1-store.md`,
`workspaces-2-launch.md`, `workspaces-3-composer.md`, `workspaces-4-sidebar.md`,
`workspaces-5-panel.md` (all in `docs/notes/`).

* Step 1 (store, `WorkspaceService`, `workspace.*` commands, session endpoint env + CLI
  loopback preference) done: `docs/notes/workspaces-1-store.md`.
* Step 2 (thread owner `workspace_id`, workspace and new-workspace threads, `--add-dir`
  siblings + CLAUDE.md env + prompt line on every spawn, `session.run-in` via `/cd`)
  done: `docs/notes/workspaces-2-launch.md`.
* Step 3 (composer: `workspace` source on the GUI event stream, workspaces above projects
  in the picker, member chips with a changeable primary, "Also in" making a new workspace
  on send) done: `docs/notes/workspaces-3-composer.md`.
* Step 4 (flat thread sidebar with Pinned / Needs attention / Terminals sections and
  `session.pin`, the Projects page with `WorkspaceMembers`, "Run in…" from the row menu
  and the palette) done: `docs/notes/workspaces-4-sidebar.md`. (The Terminals section
  is gone since the bottom panel's PR C: shells live in bottom panels.)
* Step 5 (the side panel's workspace surface: members with branch, changes, ahead/behind,
  PR and CI, add/remove, Run in, members as worktree tabs; `view.panel.workspace`; badge,
  header and Projects page entry points) done: `docs/notes/workspaces-5-panel.md`.
* Worktree tabs everywhere (2026-10-10): the Projects page's project and worktree rows
  open the worktree in the page's side panel on Enter or double-click, and a thread's
  panel lists Worktree (T, `view.panel.worktree`) for its own worktree. The main-pane
  worktree overview page (Phase 3a) is gone with it, with the `repo` and `worktree`
  selections: `docs/notes/worktree-panel-tab.md`.

### Adding projects: four PRs (design 2026-10-10)

Design and Alex's decisions in `docs/notes/add-project-handoff.md`. PR 1 (path completion
+ native folder picker, home-only enforcement) and PR 2 (non-git and remoteless projects,
`repo.git.init`) run in parallel; PR 3 (Add Project dialog, GitHub search + `gh repo
clone`) needs both; PR 4 (`repo.create`, publish via `gh repo create`) needs 3.

* PR 1 (`FilesystemService.ListDirectories`, palette path completion, native folder
  picker, `repo.Options.AllowedRoot`) done: `docs/notes/add-project-1-paths.md`.
* PR 2 (projects without git: `Repo.git`, the synthetic checkout, `RepoService.InitGit`
  and `repo.git.init`, git gating of worktree/git/pr commands and workspaces, the No git
  badge and overview, Publish to GitHub placeholder for remoteless repos) done:
  `docs/notes/add-project-2-nogit.md`.
* PR 3 (the Add Project dialog with New / Local folder / GitHub tabs, `repo.add`,
  `RepoService.SearchGitHub` / `LookupGitHub` over GraphQL, streaming `RepoService.Clone`
  via `gh repo clone` into `paths.Projects()`, `repo.clone` with CLI progress) done:
  `docs/notes/add-project-3-dialog.md`.
* PR 4 (`RepoService.Create` / `repo.create` and the New tab, `ListPublishOwners` with
  each org's visibility policy, `RepoService.Publish` / `repo.github.publish` via `gh repo
  create`, the shared owner/visibility picker, the overview's live Publish to GitHub)
  done: `docs/notes/add-project-4-create.md`.

**Adding projects: done.** All four PRs are built: register any folder under home with
completion or the folder picker, clone from GitHub, start a new project, publish it.
`project.add` is the one command for it (`code-foundry project add <folder>` on the CLI); the
old "Add Project (local folder)" command is gone: `docs/notes/add-project-remove-register.md`.

### Session usage: four PRs (design 2026-10-10)

Design in `docs/sketches/session-usage/DESIGN.md`. PR 1 first; 2, 3 and 4 in parallel
after it.

* PR 1 (`internal/pricing`, the transcript usage fold, `session_usage` + `usage_retired`,
  full rescan on discovery, `Store.Remove` retiring, proto `UsageBucket` with
  `cost_usd`/`unpriced`, `code-foundry usage`, `view.usage`) done:
  `docs/notes/session-usage.md`.
* PR 2 (subagent runs folded into the thread, every transcript a thread used rescanned
  after `/clear`, `Session.agent_runs`, per-bucket `cache_savings_usd`) done: "PR 2" in
  `docs/notes/session-usage.md`.
* PR 3 (the side panel Usage surface, per-kind bucket costs, `view.panel.usage`) done:
  "Panel surface (PR 3)" in `docs/notes/session-usage.md`.
* PR 4 (the Usage page and its sidebar toggle, Cache savings from `cache_savings_usd`)
  done: "Usage page (PR 4)" in `docs/notes/session-usage.md`.

### Bottom terminal panel: three PRs (2026-10-11)

Shells move out of the sidebar into a bottom panel under the content pane, one per thread
and one for the Projects page, keyed like the side panel.

* PR A (owner labels on every shell, `terminal.new` owner resolution, the shell reaper,
  `TerminalService.Close` / `terminal.close`, `terminal.list`, `view.bottom.toggle` on
  cmd+j) done: `docs/notes/bottom-panel-1-daemon.md`.
* PR B (the GUI panel: tabs derived from the terminal list, resize, cmd+w, one bottom
  Attach stream, new shells auto-open, focusTerminal reveals a shell) done:
  `docs/notes/bottom-panel-2-gui.md`.
* PR C (the sidebar's Terminals section and the `terminal` selection kind removed; every
  entry point lands in a bottom panel) done: `docs/notes/bottom-panel-3-routing.md`.

### Rendered threads: four PRs (design 2026-10-11)

Opt-in render mode: Claude Code runs headless (`claude -p` over stream-json) and the app
draws the conversation. Design record: `docs/notes/rendered-threads-handoff.md`.

* PR 1 (`internal/claudestream`, the stdio runner beside the PTY runner,
  `Session.render` and `thread_items`, `ThreadService`, the `thread` event source,
  `sessions.render`, `session.new --render`, the `thread.*` CLI verbs) done:
  `docs/notes/rendered-threads-1-daemon.md`.
* Sketch (variant A, `docs/sketches/rendered-thread`) done. PR 2 (GUI timeline: items
  store and Watch, virtualized work log, turn fold, diffs, highlighted markdown, docked
  prompts in a pending state, follow-up composer with send / interrupt / model /
  permission, mock daemon and e2e) done: `docs/notes/rendered-threads-2-gui.md`.
* PR 3 (answering permissions with deny reasons, AskUserQuestion single/multi/Other,
  stacked parallel prompts, keyboard 1/2/3, Escape interrupts, effort restart with
  `--resume`, `ThreadService.SetEffort` / `thread.set-effort`) done:
  `docs/notes/rendered-threads-3-interaction.md`.
* PR 4 (the composer's View picker from `sessions.render`, the header's "rendered", per-turn
  cost and model on `turn_end`, the asking subagent named on its prompts, starting / empty
  fork / crashed states, docs) done: `docs/notes/rendered-threads-4-optin.md`. All four
  rendered-thread PRs are done; follow-ups: `docs/notes/rendered-threads-followups.md`
  (branch `t3code/rendered-threads-followups-doc`). The opt-in itself is history: see
  "Rendered-only threads" below.

### Rendered-only threads (2026-10-12)

The terminal thread mode is removed: every thread is `claude -p` over stream-json. Gone:
the PTY runner, `internal/claudestatus` (the screen detector), `Session.render` /
`terminal_id`, `session.new --render`, the `sessions.render` setting, the composer's View
picker, the terminal content pane and its disconnected page. Decision record and what
changed: `docs/notes/rendered-only.md` (daemon detail `rendered-only-daemon.md`, GUI
detail `rendered-only-gui.md`). Follow-ups Alex owns: plan mode, the Bedrock cache break
on reconnect, importing claude-foundry threads (not planned).

### Slash commands in the composer: two PRs (2026-10-13)

The composer's "/" card offers, for a running thread, the commands Claude itself reports
(initialize's `commands`, kept current by `commands_changed`) minus a daemon-side deny
table; Send refuses the commands the app replaces (`/clear`, `/model`, ...).

* PR 1 (daemon: claudestream decode, per-thread cache, snapshot + Watch event,
  `ThreadService.SlashCommands`, `thread.commands`, the deny table and send guard) done:
  `docs/notes/slash-commands-1-daemon.md`.
* PR 2 (GUI: the "/" card reads the thread's list, ListSkills for threads not running;
  the refusal shown under the composer) done: `docs/notes/slash-commands-2-gui.md`.

### Archived threads: two PRs (2026-10-13)

Manual, reversible archive: closes Claude, removes the thread's shells, unpins, stamps
`archived_at`; pin and send unarchive (reconnect did until 2026-10-15). PR 1 (proto, store, migration 0017,
`session.archive` with confirmation only mid-turn via `Command.ConfirmIf`, API and view
mapping) done: `docs/notes/archive-threads-1-daemon.md`. PR 2 (the sidebar as stacked
panels: the main list scrolling above the Working and Archived footers; single-line
archived rows with their age; Archive / Unarchive in the row menu and thread header; an
archived thread's side and bottom panels reset) done: `docs/notes/archive-threads-2-sidebar.md`.

### Snoozed threads: two PRs (2026-10-14)

Snooze a thread until a time: closes Claude, removes its shells, unpins and unarchives
it, sets `snoozed_until`; the daemon wakes it (wall-clock check every 30 s and at
startup) into NEEDS_ATTENTION "snooze ended". Pin, send and archive unsnooze.
PR 1 (proto, store, migration 0018, `session.snooze` with its `until` parser and
confirmation only mid-turn, API and view mapping) done:
`docs/notes/snooze-threads-1-daemon.md`. PR 2 (the Snoozed sidebar footer with the time
left; the Snooze submenu, header button and custom date dialog; "Snooze ended" in amber;
snoozed threads out of attention; panels reset like archive; mock daemon) done:
`docs/notes/snooze-threads-2-sidebar.md`.

### Actions: per-project commands (2026-10-14)

Per-project actions modelled on T3 Code's: name, command, icon, in a terminal or in the
background, run on worktree create. A thread's agent runs them with `code-foundry action
run` (its `CODE_FOUNDRY_SESSION` makes it the owner); the user runs them from the thread
header, a terminal run opening as a tab in the bottom panel. Sketch:
`docs/sketches/actions/`.

* PR A (migration 0020, `internal/store/action` with the terminal and background runners,
  `ActionService` + the EventService action source, `kind=action` terminals the reaper
  keeps when they exit, `action.*` commands with `--wait` exit codes,
  `CODE_FOUNDRY_SESSION` as the CLI's default `--context-session`, on-worktree-create
  runs) done: `docs/notes/actions-1-daemon.md`.
* PR B (GUI: the header's and Projects rows' Play menu, the editor dialog through
  `action.add/edit/remove`, `kind=action` bottom-panel tabs with the command echo and a
  status line, Stop/Rerun, the failed-setup toast with the run's output; mock daemon)
  done: `docs/notes/actions-2-gui.md`.
* PR C pending.

### Thread lifecycle: the daemon starts and stops Claude (2026-10-15)

Users never manage whether a thread's `claude` runs: a message starts a stopped thread
(resuming its conversation), and a thread idle at its prompt past its prompt cache expiry
stops. `session.close` and `session.reconnect` are gone (PR C deleted the hidden reconnect).
Three PRs:

* PR A (background shells tracked, `Session.BackgroundWork()`, the strip counts them)
  done (#105): `docs/notes/background-shells.md`.
* PR B (daemon + CLI: start on send, the idle stop, settings on stopped threads, slash
  commands and MCP status persisted (migration 0021), crash vs idle exit items, the two
  commands removed, restart counts) on `cf/thread-lifecycle` (#108):
  `docs/notes/thread-lifecycle.md`.
* PR C (GUI: nothing shows whether Claude runs; no Reconnect card, Close, starting/closing
  indicators, disconnected badge or dimming; the composer always sends; the hidden
  `session.reconnect` deleted) on `cf/hide-connection-state`: `docs/notes/hide-connection-state.md`.

### Release channels: stable and tip (design 2026-10-11, revised 2026-10-12)

Two channels, one install: every push to main publishes a `vX.Y.Z-tip.N` prerelease
(`X.Y.Z` the next stable, `N` the tip releases since the last stable), `make promote` tags
a full `vX.Y.Z`; an `update.channel` setting picks which the updater follows, downgrades
are never offered, the GUI shows tips as `vX.Y.Z (tip N)`, and the migrator refuses a
database from a newer build. Design record: `docs/notes/release-channels-handoff.md`.

* PR 1 (workflow, release/install scripts, `make promote`, tip pruning): done: see docs/notes/release-channels-1-pipeline.md.
* PR 2 (`update.channel`, channel-aware source, migration guard, dialog label): done: see docs/notes/release-channels.md.

### Open items

Collected from the step notes; none blocks daily use.

* **Threads**
  * Removing a thread does not offer to remove the worktree `thread.new` created for it.
  * The composer prompt is a TipTap editor (inline image chips); the main bundle is over Vite's 500 kB warning, unmeasured whether TipTap pushed it there.
  * The GUI does not show `Thread.status_reason` (the CLI does). A badge tooltip or the thread header could.
  * "Viewed" means "has an Attach subscriber": a minimized or occluded window keeps acknowledging finished turns. Detaching on `visibilitychange` would fix it.
  * Memory gate measured the daemon only; the GUI (WKWebView) was not measured.
* **Git operations**
  * `git.push --force-with-lease` runs without a confirm prompt. `Command.Confirm` applies to every invocation, so confirming only the forced form needs an arg-conditional confirm.
  * Opening a link from the Pull Requests page or overview runs 3c's `view.open.url`, which shows a short "Open <url>" success toast each time.
  * `CODE_FOUNDRY_EDITOR` remains as a fallback when `gitops.editor_command` is empty.
* **GitHub / Pull Requests page**
  * Populated PR lists have only been seen live through the `CODE_FOUNDRY_GH_SEARCH_AS` dev knob. The owner's account has no PRs, so with the real login the GUI has only ever shown empty lists.
  * Dashboards are fetched unfiltered (50 per list) and filtered to tracked repositories at read time. A viewer with many PRs outside registered projects can crowd out registered ones.
  * The poll (`gh-viewer-polling.md`) keeps richer PR detail (merge state, size, reviews, review requests) and a "reviewed by you" list that no view shows yet.
  * Branch PRs on the overview show only the viewer's own, non-fork PRs.
* **Side panel + PR surface** (`side-panel.md`)
  * Files and Diff surfaces, and the PR surface's Code tab, are disabled placeholders.
  * The PR menu has no Check out, Copy PR number, description editing, labels or replies; the picker lists org teams only when already requested.
  * PR threads use the settings' model and effort (no picker in the menu), and the menu does not say beforehand which worktree a thread will start in.
  * Not run in the real Wails window.
* **Settings**
  * Saving from the app rewrites `settings.toml`, which drops user comments and unknown keys.
* **Packaging and updates**
  * Releases are live: a tip prerelease per push to main, stables by `make promote`. The `install.sh` one-liner has not been run from a fresh machine.
  * Homebrew tap deferred (needs a separate repo).
  * A real Finder double-click launch is unverified (`env -i … open` stood in for it). macOS arm64 only.
* **Integration pass**
  * The custom View menu (no Reload / Zoom items, `gui/app.go`) has not been checked in a running Wails window. Screen capture is unavailable on this machine.

## Phase 0 — Foundation (serial, one agent)

Lands the skeleton every other step depends on.

* Go module, `Makefile`/`Taskfile` with `build`, `check` (vet, staticcheck, test), `gen`.
* `buf.yaml`, `buf.gen.yaml`, `proto/codefoundry/v1/health.proto`, committed generated code
  for Go and TS.
* `internal/paths`, `internal/daemon` with both listeners, token file, graceful shutdown,
  single-instance lock.
* `internal/bus` generic event bus with tests.
* `internal/client` with auto-start of the daemon.
* `cmd/code-foundry`: `daemon`, `status`, `version`.
* `gui/`: Wails v3 scaffold, Vite + React + TS + Tailwind + shadcn, Connect-Web client,
  token handshake, a page that renders `HealthService.Ping`.
* CI workflow: `make check` + frontend lint/test.

## Phase 1 — Stores and registry (parallel)

| Step | Scope | Proto |
|---|---|---|
| 1a Terminal | `store/terminal`: PTY + libghostty-vt actor, tee, ring buffer, snapshot serializer, `TerminalService` | `terminal.proto` |
| 1b Repo | `store/repo`: register, worktrees via `git`, status, fsnotify reconcile, `RepoService` | `repo.proto` |
| 1c GitHub | `store/gh`: `gh api graphql` PRs/checks/viewer, SQLite cache, pacing, `GhService` | `gh.proto` |
| 1d Commands | `internal/command` registry, `CommandService`, CLI verb generation from the registry, `UiService` | `command.proto`, `ui.proto` |
| 1e GUI shell | sidebar/content/footer layout, Zustand slices, palette (`cmdk`) bound to `CommandService`, keybinding map, xterm.js `TerminalRenderer` against `TerminalService` | — |

Each step owns its proto file. Steps do not edit each other's packages. Shared needs go
through `bus` or a new proto message in the owner's file.

## Phase 2 — Sessions (parallel after Phase 1)

Decisions (Alex, 2026-10-08):

* **Sessions are the unit.** The content pane for a session shows exactly one of two
  things: the live Claude Code terminal, or a "not connected" state with a one-action
  reconnect. Nothing else. Generic terminals stay supported but are secondary.
* **Close = graceful.** Closing a session clears any pending input (Escape, Ctrl-U), sends
  `/exit`, waits for the process to exit (bounded), falls back to Kill, then removes the
  terminal. The session row remains, in the disconnected state, until the user removes it.
* **User-typed `/exit` is normal.** Process exit with no close request transitions the
  session to disconnected (not an error). Reconnect spawns `claude --resume <session id>`
  in the same worktree with the same model/effort and rebinds the row to the new terminal.
* **Trust dialog is always accepted** for worktrees of registered repositories. Prefer
  pre-trusting via Claude's own config if its format is stable; otherwise detect the dialog
  text in the output stream and answer it. Never show it to the user.
* **Scrub inherited Claude env.** The daemon strips `CLAUDECODE` and `CLAUDE_CODE_*` from
  its own environment at startup. Observed 2026-10-08: a daemon started from inside a Claude
  session passed `CLAUDE_CODE_CHILD_SESSION` to children, which disabled transcript saving.

Steps:

* 2a `store/session`: spawn `claude`, JSONL discovery (session id from
  `~/.claude/projects/<slug>/`), resume, auto-naming via `claude -p`, close/reconnect state
  machine, `SessionService`. Sets `labels.session` and `labels.worktree` on its terminals.
* 2b Status detection: pure event-driven state machine (busy / idle / needs-attention)
  fed by a program-agnostic observer hook on the terminal actor (not an Attach subscriber),
  plus JSONL; table tests; wired into 2a.
* 2c GUI: session rows in the sidebar, new-session flow (model/effort), status badges,
  disconnected state + reconnect, needs-attention surfacing. Collapse Watch streams into
  one shared events stream first: the browser's 6-connections-per-origin limit is already
  close with four open streams.
* 2d CLI: `session new|list|focus|close|reconnect|rename|fork` from the registry (close
  and reconnect removed on 2026-10-15: `docs/notes/thread-lifecycle.md`).

## Phase 3 — Supervision surface (parallel after Phase 2)

Decisions (Alex, 2026-10-08), modeled on the work TUI's screens:

* **Pull Requests page** (global, replaces the idea of a "dashboard"): monthly tiles
  (commits / PRs merged by the viewer for this month and last), **Open PRs authored by you**,
  **PRs awaiting your review**, **Merged PRs in the last 7 days** (repo, number, author,
  title, age). All from `gh` across registered repos' GitHub slugs.
* **Worktree overview page**: upstream sync line; GitHub activity for the repo (viewer's
  merged PRs and commits this/last month, default-branch CI status with failing check
  names, merged-in-last-7-days involving the viewer, PRs authored by the viewer for this
  branch); **Files** changed against the base branch with per-file status and +/- counts;
  **Log** of commits on the branch not on base. This is the baseline; Alex had further
  updates planned and will direct them later.
* **Settings** live in a file under the config home and are editable in the UI.
* **Packaging and updates**: a GitHub release per version holding the app (originally a
  bundle with the CLI/daemon inside it; now a tarball of the two executables, see
  `docs/notes/bare-binary-distribution.md`) and a curl-able `install.sh` that uses `gh release download` into a
  user-owned location with PATH setup; an in-app updater that checks every 24h via `gh`,
  surfaces "update ready" in the footer and palette, installs on request, and reports
  "ready on next restart". The daemon must not be restarted automatically (it would kill
  sessions); offer a `daemon.restart` command that says how many sessions it will close.
  Homebrew tap is deferred (needs a separate repo).

Steps:

* 3a Pull Requests page + worktree overview (full stack): gh store additions (viewer
  dashboards, monthly stats, default-branch checks), repo store additions (files vs base,
  log vs base), additive proto changes, GUI pages.
* 3b Settings + help + confirm: `settings.proto`, file-backed settings store with a typed
  schema, settings UI, help overlay, confirm flag on destructive commands.
* 3c Git operations: `gitops.proto`/store for fetch, pull, push, PR create/open via `gh`,
  open-in-editor/Finder; exposed only as registry commands.
* 3d Packaging + updater: release script, `install.sh`, bundle layout with the CLI inside
  the app, `update.proto` + store with a 24h check, `app.update`, `daemon.restart`, GUI
  indicator and dialog.

## Gates

* No step merges with a failing `make check`.
* Any change to a `v1` proto after Phase 1 is additive only.
* Memory check at the end of Phase 2: daemon + GUI with ten idle sessions attached one at a
  time, measured with `footprint`, recorded in `docs/perf.md`.
