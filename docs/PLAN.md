# Build plan

Phases are ordered by dependency. Steps inside a phase run in parallel, each on its own
branch off `main`, each landing through a PR. A step is done when it builds, its tests
pass, `make check` is green, and its doc note is written.

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
* 2d CLI: `session new|list|focus|close|reconnect|rename|fork` from the registry.

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
* **Packaging and updates**: a GitHub release per version holding the app bundle (with the
  CLI/daemon inside it) and a curl-able `install.sh` that uses `gh release download` into a
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
