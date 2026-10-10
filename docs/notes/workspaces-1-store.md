# Workspaces step 1: store, proto, commands, session transport

Status: done on branch `cf/workspaces-store`. `make check` green. Exercised end to end on a
scratch daemon (below). Design record: `workspaces-handoff.md` (sections 3, 5, 7). Steps
2–5 (launch flags, composer, sidebar, panel) are not started.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/workspace.proto` | `WorkspaceService`: List, Create, AddRepo, RemoveRepo, Remove, Members, Watch (snapshot, then `updated` / `removed_id`, snapshot again on drops) |
| `proto/codefoundry/v1/command.proto` | `ArgSpec.default_to_cwd` (additive) |
| `internal/db/migrations/0007_workspaces.sql` | `workspaces(id, name UNIQUE, branch, created_at)`, `workspace_members(workspace_id → workspaces ON DELETE CASCADE, repo_id, worktree_path UNIQUE, added_at, PK(workspace_id, repo_id))` |
| `internal/store/workspace` | `Store` interface, `*Manager`, pure lookups (`resolve.go`), persistence (`db.go`) |
| `internal/store/workspace/workspacetest` | in-memory `Fake` publishing the same events |
| `internal/api/workspace.go` | thin handler |
| `internal/command/commands_workspace.go` | `workspace.new`, `.list`, `.members`, `.add-repo`, `.remove-repo`, `.remove` |
| `internal/client` | `EndpointFromEnv`, `ConnectOptions.Endpoint` |
| `internal/daemon` | store wiring (`stores.go`), loopback listener before the stores, `sessionEnv`, `scrubEndpointEnv` |
| `internal/store/session` | `Options.Env` on every spawn; `Manager.PreTrust` |

## Decisions

* **Workspace = `{id, name, branch, members[{repo_id, worktree_path}]}`.** Ids are
  `w-` + 12 hex. Names are unique. A repo is in a workspace at most once; a worktree
  belongs to one workspace. Members keep insertion order. No base ref or time is kept
  per member (handoff: no bookkeeping).
* **Branch** defaults to `cf/<name as a slug>` (lowercase ASCII words joined by `-`, at
  most 60 bytes), the same `cf/` namespace new threads use.
* **Worktrees go through the repo store** (`repo.Store.CreateWorktree` with `Fetch`,
  the composer's path), honoring `repos.worktree_dir` via the daemon's
  `settingsWorktreePath`, and are pre-trusted with `session.Manager.PreTrust` (the same
  `~/.claude.json` edit spawn does). A trust failure is logged, not fatal.
* **Create is all or nothing.** Every repo ref and base is resolved before git runs. If
  member N fails, members 1..N-1 are removed again (`--force`) and their branch deleted
  only when Create made it (checked with `ListRefs` beforehand). Nothing is persisted.
* **Repo refs** accept an id, a name when exactly one repo has it (ambiguous names list
  the ids), or an absolute path inside the repo or any of its worktrees. `workspace new
  --repos web,api:origin/develop` gives a per-repo base after `:` (refs cannot contain
  `:`); `--base` is the default for the rest.
* **Workspace refs**: id, then name, else the member worktree containing `cwd` (deepest
  wins). Paths are compared both cleaned and symlink-resolved; a path that does not
  exist resolves its longest existing ancestor (`/tmp/x/missing` ≡
  `/private/tmp/x/missing`).
* **Removal guard.** The store does not import `session` (step 2 will make the session
  store read workspaces, so the dependency must point that way). The daemon passes
  `Threads func() []Thread`: sessions whose state is not DISCONNECTED (starting,
  connected, closing). RemoveRepo and Remove refuse while any of them has its cwd inside
  a member worktree and name them: `thread driver (s-…) running in <path>; close it
  first`.
* **Dirty check** is git's own (`git worktree remove` without `--force` refuses), so
  RemoveRepo is exactly `repo.worktree.remove`. `workspace.remove` additionally refreshes
  every member's repo and refuses up front when any member is dirty, so it does not leave
  a half-removed workspace in the common case. If git still refuses midway, members
  already removed are dropped and the rest are kept.
* **Members that are already gone** (worktree deleted by hand) are dropped on removal.
  A member whose repo was unregistered is dropped and its files are left on disk
  (logged); the repo store cannot remove a worktree of a repo it does not know.
* **`workspace members`** prints a header line and one aligned row per member:
  `REPO ID WORKTREE BRANCH`, the branch being what is checked out now (from the repo
  snapshot), with `(current)` on the member containing the cwd and `(missing)` when the
  repo store does not list the worktree. `--json` prints `WorkspaceMembersResponse`
  (protojson), following the existing `--json` convention.
* **`--cwd` default.** New generic `ArgSpec.DefaultToCwd` (proto `default_to_cwd`, Path
  args only): the CLI sends its working directory when the flag is omitted. The same arg
  is also `Context: ContextWorktree`, so the palette uses the active worktree.
* **Session transport.** The daemon now generates its token and listens on
  `127.0.0.1:0` *before* opening the stores, so `session.Options.Env` is static:
  `CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:<port>`, `CODE_FOUNDRY_TOKEN=<token>` on every
  claude spawn (create, reconnect, fork). The names live in `internal/paths` (with
  `CODE_FOUNDRY_HOME`) because `internal/client`'s tests import `internal/daemon`.
* **CLI preference.** `cmd/code-foundry` reads `client.EndpointFromEnv(os.Getenv)` and
  passes `ConnectOptions.Endpoint`. With an endpoint, `Connect` pings it and returns;
  it never starts a daemon (a new one would have another port and token), and a dead
  endpoint or a wrong token is an error naming `CODE_FOUNDRY_ENDPOINT`. A set endpoint
  without a token, a non-http URL, or a non-loopback host is an error. Outside sessions
  (variable unset) nothing changes. `status` gained a `transport` row.
* **The daemon drops an inherited `CODE_FOUNDRY_ENDPOINT`/`TOKEN`** from its own
  environment at start (like the Claude variables), so a daemon started by hand inside a
  session does not point its plain terminals at the other daemon.

## Deviations from the handoff / brief

* **Command names may now be kebab-case after the first segment.** The handoff names
  `workspace.add-repo` / `workspace.remove-repo`; `NamePattern` rejected hyphens (1d had a
  test row for it). It is now `^[a-z]+(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$`; the CLI resolves
  `workspace add-repo` as words joined by dots, unchanged. Keybinding settings keys
  (`keybindings.workspace.add-repo`) are fine in TOML.
* **Added `workspace.list`** (not in the handoff's verb list): there was no other way to
  see workspaces from the CLI.
* **`ArgSpec.default_to_cwd`** is a proto addition to `command.proto`, not only
  `workspace.proto`; there was no way for a command to default to the CLI's cwd.
* **Not in `EventService` yet.** `WorkspaceService.Watch` exists; adding the `workspace`
  source to the multiplexed GUI stream belongs with the first GUI step (3 or 4).
* **An existing worktree on the branch is not adopted.** If the branch is checked out
  elsewhere, git refuses and Create rolls back.

## Gotchas

* `repo register` takes `--path` (not positional).
* `go build ./cmd/...` writes a `code-foundry` binary into the cwd; use `make build`.
* A fresh worktree needs `make ghostty-vt` (~1 min) before anything that links the
  terminal store builds or tests (`third_party/` is per checkout and ignored).
* Sessions also inherit `CODE_FOUNDRY_BIN` (the daemon sets it from `os.Executable`), so
  inside a session `"$CODE_FOUNDRY_BIN" workspace members` works even when the CLI is not
  on PATH.
* `session.close` has no `--yes` (it is not a confirmed command); `workspace.remove*` do.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  668 vitest tests.
* Tests: table tests for every lookup (`resolve_test.go`), store tests over the repo fake
  plus a real SQLite DB (persistence, events, rollback, guards, dirty paths), one test
  against real git through `repo.Start` (rollback of a branch it created, `--no-track`,
  dirty refusal, `--force --delete-branch`, re-add), API, commands, CLI e2e (kebab verb,
  cwd default), session env on create and reconnect, `EndpointFromEnv`, Connect with an
  endpoint over a bogus socket path, wrong token, dead endpoint creates nothing.
* **Scratch daemon** (`CODE_FOUNDRY_HOME=/tmp/cf-ws-12881/home`,
  `CLAUDE_CONFIG_DIR` scratch, `advanced.claude_path` = a shell script standing in for
  claude, three scratch repos, `web` with a bare origin):
  * `workspace new login --repos web,api` → `cf/login` worktrees in both, no upstream,
    both trusted in the scratch `.claude.json`; `workspace list`.
  * `workspace members --cwd <web member>/sub` (non-existent subdir; this found the
    realPath bug, fixed in `fc749ba`) and `cd <api member> && workspace members` (cwd
    default) both print the members with `(current)` on the right row. Persisted across a
    daemon restart.
  * `cd <web member> && workspace add-repo lib` → worktree on `cf/login`. With an
    untracked file: `remove-repo lib` refused by git ("use --force"), `workspace remove
    login` refused up front ("uncommitted changes in lib (...)"),
    `remove-repo lib --force --delete-branch` removed worktree and branch.
  * `session new --worktree <web member> --name driver`: the stand-in claude saw
    `CODE_FOUNDRY_ENDPOINT=http://127.0.0.1:<port>` and the token, and with
    `CODE_FOUNDRY_HOME=/nonexistent` (socket unreachable) `code-foundry workspace members`
    printed the members, `(current)` on web, exit 0. While it ran, `remove-repo web` and
    `remove login` were refused naming `thread driver (s-…)`. After `session close`,
    `workspace remove login --delete-branch` removed both worktrees and branches.
  * `status` with `CODE_FOUNDRY_HOME=/tmp/cf-bogus-home` and the endpoint/token set:
    pid, version, `transport loopback (CODE_FOUNDRY_ENDPOINT)`, exit 0, bogus home not
    created. Wrong token: `unauthenticated: 401`, exit 1. Dead endpoint
    (`127.0.0.1:1`): `connection refused`, exit 1, no daemon started, home not created.
  * `workspace new bad --repos web,api:no-such-ref`: api failed with git's "invalid
    reference"; the web worktree and its new branch were rolled back.
  * Daemon log: no warnings or errors outside the gh poller. Scratch daemon stopped.

## To check on the work laptop

Use a scratch home so the installed daemon is untouched. `ui` and `service` stand for two
of your repos; replace the paths.

```sh
cd ~/projects/code-foundry && git fetch && git switch cf/workspaces-store && make build
export CODE_FOUNDRY_HOME=~/.cf-ws-check
./bin/code-foundry daemon --dev > /tmp/cf-ws-check.log 2>&1 &
./bin/code-foundry repo register --path ~/src/ui
./bin/code-foundry repo register --path ~/src/service
./bin/code-foundry workspace new ws-check --repos ui,service
./bin/code-foundry workspace members ws-check     # note both worktree paths
UI=<ui worktree path>; SVC=<service worktree path>
```

**(a) Loopback CLI from inside a sandboxed session.** The session's Bash runs in the
work sandbox (Unix sockets blocked):

```sh
./bin/code-foundry session new --worktree "$UI" --model haiku --effort medium --name ws-check \
  --prompt 'Run exactly: "$CODE_FOUNDRY_BIN" workspace members > ws-members.txt 2>&1; echo "exit=$?" >> ws-members.txt. Keep the sandbox on; if it fails, do not retry outside the sandbox, just stop.'
sleep 60; cat "$UI/ws-members.txt"
```

Expect the members table with `(current)` on ui and `exit=0`. A `connection refused` or
`operation not permitted` here means the sandbox blocks loopback after all; a socket
error means the CLI did not see `CODE_FOUNDRY_ENDPOINT`.

**(b) `git commit` in a sibling worktree reached via `--add-dir`** (step 2 will add the
flag automatically; this runs claude by hand to answer the open question first):

```sh
cd "$UI" && claude --model haiku --effort medium --permission-mode auto --add-dir "$SVC" -- \
  "Create $SVC/ADD_DIR_CHECK.md with one line, then run: git -C $SVC add ADD_DIR_CHECK.md && git -C $SVC commit -m 'add-dir check'. Keep the sandbox on; if the commit fails, show git's exact error and stop."
git -C "$SVC" log -1 --oneline     # expect "add-dir check"
```

The question is whether the sandbox lets the commit write the sibling's shared `.git`
(it lives in the service repo's main checkout, outside both the cwd and the added dir).

Clean up:

```sh
./bin/code-foundry session close --id <id from `session list`>
./bin/code-foundry workspace remove ws-check --force --delete-branch --yes
kill %1; rm -rf ~/.cf-ws-check
```
