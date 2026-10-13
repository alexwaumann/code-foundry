# Project-less threads, step 1: daemon, proto, CLI

Status: done on branch `t3code/no-project-daemon` (PR a of 2). `make check` green, exercised
end to end on an isolated daemon with a real haiku thread (below). PR b (the GUI) stacks on
this branch.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/session.proto` | `CreateSessionRequest.no_project = 14`; the ownership comment on `Session` is three-way |
| `internal/store/session/manager.go` | `Options.Home` (default `os.UserHomeDir()`), the `NoProject` branch in `Create`, exclusivity check |
| `internal/store/session/session.go` | `CreateOptions.NoProject`, owner rule on `Session` |
| `internal/store/session/thread.go`, `manager.go` | file references never match an empty repo id |
| `internal/api/session.go` | maps `no_project` |
| `internal/command/commands_session.go` | `session new --no-project`, `canStartThread` also true for the `compose` view |
| `internal/termlabel` | doc: a no-project thread's shells have an empty `repo` label and `worktree` = home |

## Decisions

* **Owner rule** (proto comment on `Session`): workspace when `workspace_id` is set, else
  the project when `repo_id` is set, else no project. A thread without a project has an
  empty `repo_id` and `workspace_id` and `worktree_path` = the daemon's home directory.
  No migration: old rows with an empty `repo_id` and a path inside a project still exist
  (sole user); clients may keep placing those by their path.
* **`no_project` is exclusive** with `repo_id`, `worktree_path`, `new_worktree`,
  `workspace_id` and `new_workspace`: `Create` returns `ErrInvalidArgument` (Connect
  `invalid_argument`) before anything is made. The command refuses the same args
  (`repo`, `worktree`, `workspace`, `repos`, `new-worktree`, `base`) with an ArgError
  naming the first one; a `repo` or `worktree` filled from the caller's context counts
  too, so the GUI must invoke `session.new --no-project` with a context that has neither.
* **No hidden "Home" project.** A registered project at `~` would appear on the Projects
  page, be polled by the repo store and its watcher, offer Initialize Git on `~`, and be
  indexed for `@` file completion. The thread simply has no owner instead.
* **Trust**: the home directory is pre-trusted like every other cwd (`trustWorktree` in
  `spawn`), with no special case. Accepted because the work laptop is a managed device
  with a locked-down, sandboxed Claude. Note Claude's trust check walks up to trusted
  parents, so a trusted `~` covers every folder under it.
* **RunIn** refuses a thread without a workspace already (`FailedPrecondition`, "does not
  belong to a workspace"); a no-project thread is one. **Fork** and **Reconnect** copy
  the row's cwd and owner fields, so both stay in home with an empty owner, also across
  a daemon restart.
* **File references** (`cf-file://<repo>/<path>`) never resolve for a no-project thread:
  the resolver now requires a non-empty `RepoID` before matching, so every token becomes
  its relative path and is logged, as for any repo outside the thread.
* **Shells**: `terminal.new` for such a thread labels it `session=<id> repo= worktree=<home>`
  and starts it in home. The reaper only reaps by a non-empty repo label, and home never
  disappears, so its shells live until they exit or the thread is removed.
* **`session.new` availability** (not in the brief): `canStartThread` is also true for
  `ActiveView == "compose"`, because a composer whose target is no project has no repo or
  worktree in its context. The dashboard, PR page and other views still need a repo or
  worktree. `Run` still needs a target (repo, worktree, workspace, repos or no-project).
* Labels like "No project" are the GUI's: the daemon gives terminals and threads only ids
  and paths.

## Checked and left alone

`grep RepoID` across the session store, API, commands, termlabel and the daemon:
usage, linked PRs, transcripts (`~/.claude/projects/-Users-<you>`), naming, MCP, slash
commands and pins are keyed by the thread and never by the project. The cleanup hold
and the workspace store's live-thread check match a thread whose cwd is inside a
worktree; home never is. Project-scoped commands (`git.*`, `worktree.*`,
`view.panel.worktree`, `repo.git.init`) need an active repo id, which a no-project
thread does not have.

## Gotchas

* A test env's `create` helper filled in `e.wt` whenever no repo or path was given; it now
  skips that for `NoProject`.
* `os.UserHomeDir` is resolved once in `withDefaults`; tests inject `Options.Home` (the
  env's `home` temp dir), so no test touches the real home or its trust.
* The e2e pre-trusted `/Users/alex` in the real `~/.claude.json` (the isolated daemon
  still uses Alex's Claude config). That entry stays; it is what the feature does on first
  use anyway.

## End to end (isolated daemon)

`make build`, `CODE_FOUNDRY_HOME=/tmp/cf-noproj bin/code-foundry daemon --dev`:

1. `session new --no-project` with each of `--repo x`, `--worktree /tmp`,
   `--workspace w`, `--new-worktree`, `--new-worktree --repos a,b`, `--base main`: each
   refused ("no-project starts a thread without a project; it does not take repo", …).
   `session new --model haiku` alone: "a worktree, repository, or workspace is required
   (or no-project)".
2. Raw Connect JSON to `SessionService/Create` with `{"noProject":true,"repoId":"x"}` and
   with `newWorkspace`: `invalid_argument` "no project excludes a repo, worktree, new
   worktree, workspace and new workspace".
3. `session new --no-project --model haiku --effort medium --prompt "Reply with just OK. Do
   not read or edit any files."` → "created thread s-… in /Users/alex (no project)". Log:
   "pre-trusted worktree in claude config path=/Users/alex", spawn `cwd=/Users/alex`.
   `session list --json`: `repoId` and `workspaceId` empty, `worktreePath` `/Users/alex`;
   `thread items`: "claude: OK", turn end success on claude-haiku-5-5; status
   needs-attention "finished" (no viewer watched the turn).
4. `session run-in --id <it> --repo x`: "failed precondition: thread … does not belong to a
   workspace".
5. `terminal new --context-session <it>`: cwd `/Users/alex`, labels
   `kind=shell repo= session=<it> worktree=/Users/alex`.
6. `session close`, `session reconnect` (`--resume <claude id>`, cwd home), `session fork`
   (`--resume … --fork-session`, cwd home, empty owner).
7. Daemon stopped; no warnings or errors in its log. Scratch transcript and
   `/tmp/cf-noproj` removed.

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  2084 vitest tests.
* Tests: `TestCreateNoProject` (cwd = injected home, owner empty, home pre-trusted),
  `TestCreateNoProjectIsExclusive`, `TestRunInRefusesNoProjectThread`,
  `TestNoProjectThreadSurvivesForkReconnectAndRestart`, `TestNoProjectFileRefs`, a
  `TestCreateRewritesFileRefs` row, `TestSessionCreateNoProject` (API), `session.new`
  rows (no-project, composer availability, every refusal, context repo),
  `TestTerminalNewOwner` and `TestShellReaper` rows.

## Daemon restart

The installed daemon must be restarted to pick this up (new request field). No migration.
