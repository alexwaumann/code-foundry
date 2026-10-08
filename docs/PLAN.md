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

## Phase 3 — Supervision surface

* PR overview page per worktree (PRs, checks, merge state) from `GhService`.
* Git actions dialog (fetch, pull, push, create PR via `gh`).
* Settings, help overlay, confirm prompts.
* Packaging: signed `.app`, Homebrew tap, `code-foundry update`.

## Gates

* No step merges with a failing `make check`.
* Any change to a `v1` proto after Phase 1 is additive only.
* Memory check at the end of Phase 2: daemon + GUI with ten idle sessions attached one at a
  time, measured with `footprint`, recorded in `docs/perf.md`.
