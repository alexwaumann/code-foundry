# Actions, PR A: the daemon half (2026-10-14)

Actions are per-project command lines, modelled on T3 Code's Actions: a name, an icon, the
command, whether it runs in a terminal or in the background, and whether it runs when a
new thread creates its worktree. A thread's agent runs them with `code-foundry action
run`; the user runs them from the GUI (PR B), where a terminal run opens as a tab in the
bottom panel. PR B (GUI: header menu, editor dialog, the action tab's status line) and
PR C follow. Sketch: `docs/sketches/actions/`.

## Storage

* Migration `0020_actions.sql`: `actions(id, repo_id → repos ON DELETE CASCADE, name,
  command, icon, in_terminal, on_worktree_create, position, created_at, updated_at)`,
  STRICT, unique index on `(repo_id, name COLLATE NOCASE)`. The first table with a
  foreign key to `repos`: `repo.Unregister`'s `DELETE FROM repos` removes a project's
  actions (foreign_keys is on for every connection). Re-registering the same folder (same
  id) starts with no actions.
* The store checks names too (`strings.EqualFold`, Unicode; the index is ASCII NOCASE) so
  the error reads "this project already has an action named "Test"" (FailedPrecondition).
* Icons: play (default), test, lint, configure, build, debug, stored as text, checked by
  the store, an enum on the wire (`ActionIcon`).
* `position` is 0..n-1 per project; Update with a position moves the action (clamped)
  and renumbers; Delete closes the gap.
* Commands may span lines (the shell runs them as a script); CRLF becomes LF, trailing
  whitespace is dropped, NUL is refused. Names are one line, at most 64 runes.

## Store (`internal/store/action`)

* Shape of the workspace store: SQLite rows, an immutable `Snapshot` (actions by project
  then position, runs newest first) behind an atomic pointer, events on the bus. Fake:
  `actiontest.Fake`.
* Runs live in memory only: newest 50 per project, a running run is never forgotten.
  Snapshots and events never carry a run's output; `GetRun`, `Wait` and `Run`'s answer do.
* Every run executes `<$SHELL> -lc <command>` (`$SHELL` of the daemon, else `/bin/zsh`)
  in the owner's worktree with `CODE_FOUNDRY_PROJECT_ROOT` (the project's main checkout),
  `CODE_FOUNDRY_WORKTREE` (the worktree, also the cwd) and, for a thread's run,
  `CODE_FOUNDRY_SESSION` added to the daemon's environment.
* **Owner**: a thread (`session_id`; its project and worktree, looked up in the session
  snapshot) or a registered worktree (`worktree_path`, matched exactly against the repo
  snapshot). A thread without a project is refused (FailedPrecondition). The action is
  found by id, else by name (ignoring case) in the owner's project; an id from another
  project is refused.
* **Terminal runner**: a terminal-store terminal with argv `[$SHELL, -lc, command]` and
  the labels below. Its exit comes from the terminal's `Observer` (no polling). `Wait`
  also checks once a second that the terminal still exists; a terminal that vanished
  without an exit finishes the run with exit code -1.
* **Background runner**: `os/exec` in its own process group (Setpgid), stdin /dev/null,
  stdout and stderr into one tail buffer (last 64 KiB; invalid UTF-8 becomes U+FFFD),
  `WaitDelay` 2s so a process it left in the background cannot hold the run open. Exit
  code is the status, 128+signal when signalled. Kill: SIGTERM to the group, SIGKILL
  after 3s.
* Background runs are killed on daemon shutdown (`Manager.Close`, before the session
  store shuts down), when their project is unregistered, their thread removed, archived
  or snoozed, or their worktree directory removed (`internal/daemon/actions.go`, same rules as the shell
  reaper, including "WorktreeRemoved only counts when the directory is gone").
* `RunFinished` (run, action, name, repo, session, terminal, mode, trigger, exit code)
  follows the finishing `RunUpdated`, once per run.

## Label contract (`internal/termlabel`, `Terminal.labels` in terminal.proto)

| Terminal | `kind` | `session` | `repo` | `worktree` | `action` | `action.name` | `action.run` |
|---|---|---|---|---|---|---|---|
| Shell for a thread | `shell` | thread id | thread's repo | thread's worktree | | | |
| Shell for a worktree | `shell` | | repo id | worktree path | | | |
| Action run for a thread | `action` | thread id | thread's repo | thread's worktree | action id | name at start | run id |
| Action run for a worktree | `action` | | repo id | worktree path | action id | name at start | run id |

* `termlabel.IsPanel` (shell or action) is what the bottom panel shows, what
  `terminal.close` / `TerminalService.Close` accept, what `session.Manager` removes with a
  thread (remove, archive, snooze), and what the reaper kills with an owner.
* The reaper still removes an exited **shell** at once, but never an exited **action**
  terminal (neither on the exit event nor in the sweep): it stays EXITED so the user can
  read the output, and the GUI closes it. An exited action terminal still goes with its
  thread, project or (deleted) worktree.
* PR B keys tabs exactly like shells, with `kind in (shell, action)`.

## Commands (CLI verbs come from the registry)

```
code-foundry action list   [--repo id|name|path]
code-foundry action add    <name> --command '<cmd>' [--icon play|test|lint|configure|build|debug]
                           [--in-terminal=false] [--on-worktree-create] [--repo ...]
code-foundry action edit   <name|id> [--name ..] [--command ..] [--icon ..] [--in-terminal[=false]]
                           [--on-worktree-create[=false]] [--position n] [--repo ...]
code-foundry action remove <name|id> [--repo ...]
code-foundry action run    <name|id> [--background | --terminal] [--wait]
code-foundry action wait   <run-id>
code-foundry action runs   [--repo ...]
```

* `action.run`'s owner is `terminal.new`'s (`shellOwner`, now shared and taking the
  backends): the active thread, else the context worktree, else the registered worktree
  containing `--here` (the CLI's working directory). There is no `--cwd`: a run always
  starts in its worktree.
* The other verbs pick the project from `--repo` (id, unique name, or a path inside it;
  the GUI's active project fills it), else the same owner.
* `--wait` returns the run with its output: a background run's output, then
  "`<name>` exited with code N (run r-…)". The command's `Result.ExitCode`
  (`InvokeCommandResponse.exit_code`, new) carries the code; the CLI prints the message
  on stdout and exits with it (`exitCodeError`; codes outside 0..255 become 1). A terminal
  run reports only the code.
* `action.wait` and `action.runs` were added beyond the brief: a background run started
  without `--wait` (or by the GUI) otherwise has no way to read its output from the CLI.
* Cancelling `--wait` (Ctrl-C) stops waiting, not the run.

### For agents

The daemon sets `CODE_FOUNDRY_SESSION=<thread id>` in every Claude process (beside the
endpoint and token), and the CLI uses it as the default `--context-session`. So inside a
thread:

```
code-foundry action list                      # this project's actions
code-foundry action run test --background --wait   # output on stdout, exit code = the action's
code-foundry action run dev                   # opens in this thread's bottom panel
code-foundry terminal new --run 'pnpm dev'    # also lands in this thread's panel now
```

No system-prompt line mentions actions (decided). `--context-session=` opts out. Gotcha:
every command with a session-bound argument now defaults to the agent's own thread when
the agent omits it (`thread send`, `session close`, ...). That is the point for
`terminal new` and `action run`; for the destructive ones the confirmation still applies.
The daemon scrubs an inherited `CODE_FOUNDRY_SESSION` from its own environment, like the
endpoint and token, so plain shells and action runs never inherit a stale one.

## Worktree-create hook

`session.Options.WorktreeCreated(sessionID, repoID, worktree)` is called by `Create` after
a new-worktree thread has spawned (not for existing worktrees, forks or reconnects). The
daemon passes `action.Manager.WorktreeCreated`, which returns at once and runs the
project's `on_worktree_create` actions in a goroutine, **in the background runner
regardless of `in_terminal`**, one after another in list order (a failure does not stop
the next), owned by the thread, trigger `WORKTREE_CREATE`. A non-zero exit is logged
(slog warn with the last five output lines) and published as `run_finished` for PR B's
toast. The session store does not import the action store. New-workspace threads (the
workspace store makes those worktrees) do not run the hook; left for later if wanted.

## API

* `ActionService` (`proto/codefoundry/v1/action.proto`): List(repo_id), Create, Update
  (optional fields), Delete(id), Run(action, session_id | worktree_path, repo_id, mode),
  GetRun, WaitRun, Watch. Errors: NotFound, InvalidArgument, FailedPrecondition,
  Unavailable after shutdown.
* EventService gains `EVENT_SOURCE_ACTION` (13) / `Event.action` (14), sent after
  update: `ActionEvent` snapshot (actions + runs), then `updated`, `removed_id`,
  `run_updated`, `run_removed_id`, `run_finished`.
* `ActionRun.output` is only filled by GetRun, WaitRun and Run.

## For PR B

* Run: `ActionService.Run{action: id, session_id}` for a thread's panel, or
  `{action: id, worktree_path}` for the Projects page. Mode unset = the action's choice.
  Or invoke `action.run` with the context (same owner rules).
* Tabs: terminals with `kind=action`, grouped by `session` like shells; title from
  `action.name`; `action.run` maps the tab to its `ActionRun` (command, started_at,
  finished_at, exit_code; the terminal's own `exit_code`/`exited_at` work too).
* Stop: `TerminalService.Kill` (the tab stays, EXITED 129). Close: `terminal.close`.
  Rerun: close the old tab and Run again (a terminal runs one process; there is no
  restart in place).
* Toasts: `run_finished` with `trigger=WORKTREE_CREATE` (and any background run).
* The sketch wants the command echoed dimmed at the top of the tab; the PTY does not
  print it (argv runs it directly), so the GUI has to draw it from `ActionRun.command`.

## End to end (2026-10-14, isolated home, scratch repo under ~)

`make build`; `CODE_FOUNDRY_HOME=$(mktemp -d /tmp/cfa.XXXX) bin/code-foundry daemon --dev`;
a fresh `git init` repo `~/cf-actions-e2e.lUOL` registered with `repo add`. Output as
printed (`$CF` is `bin/code-foundry`):

```
$ $CF action add Test --command 'echo "root=$CODE_FOUNDRY_PROJECT_ROOT"; echo "worktree=$CODE_FOUNDRY_WORKTREE"; echo "pwd=$(pwd)"; echo "to stderr" >&2; exit 3' --icon test --in-terminal=false
added action Test (a-93ca2ec456b2)
$ $CF action add Dev --command 'echo "dev server on $CODE_FOUNDRY_WORKTREE"; sleep 2; exit 7' --icon play
added action Dev (a-a8f54056a29b)
$ $CF action add test --command true; echo "exit=$?"
code-foundry action.add: failed precondition: this project already has an action named "Test"
Run `code-foundry help action.add` for usage.
exit=2
$ $CF action list
NAME  ID              ICON  RUNS IN     ON NEW WORKTREE  COMMAND
Test  a-93ca2ec456b2  test  background  no               echo "root=$CODE_FOUNDRY_PROJECT_ROOT"; echo "worktree=$CODE_FOUNDRY_WORKTREE"; echo "pwd=$(pwd)"; echo "to stderr" >&2; exit 3
Dev   a-a8f54056a29b  play  terminal    no               echo "dev server on $CODE_FOUNDRY_WORKTREE"; sleep 2; exit 7
$ $CF action run test --wait; echo "exit=$?"
root=/Users/alex/cf-actions-e2e.lUOL
worktree=/Users/alex/cf-actions-e2e.lUOL
pwd=/Users/alex/cf-actions-e2e.lUOL
to stderr
Test exited with code 3 (run r-8771e61bd699)
exit=3
$ $CF action run dev --background --wait; echo "exit=$?"
dev server on /Users/alex/cf-actions-e2e.lUOL
Dev exited with code 7 (run r-fa23fb043aee)
exit=7
$ $CF action run dev
started Dev in terminal t-db62eb8c7091 (run r-7bf646e4cd88)
$ $CF terminal list
ID              STATE    CWD                              LABELS
t-db62eb8c7091  running  /Users/alex/cf-actions-e2e.lUOL  action=a-a8f54056a29b action.name=Dev action.run=r-7bf646e4cd88 kind=action repo=b708d8f0629c worktree=/Users/alex/cf-actions-e2e.lUOL
$ $CF action run dev --wait; echo "exit=$?"
Dev exited with code 7 in terminal t-bf7852543c2e (run r-f2e58cdec81b)
exit=7
$ $CF terminal list      # both stay EXITED: the reaper leaves action terminals
ID              STATE     CWD                              LABELS
t-db62eb8c7091  exited 7  /Users/alex/cf-actions-e2e.lUOL  action=a-a8f54056a29b action.name=Dev action.run=r-7bf646e4cd88 kind=action repo=b708d8f0629c worktree=/Users/alex/cf-actions-e2e.lUOL
t-bf7852543c2e  exited 7  /Users/alex/cf-actions-e2e.lUOL  action=a-a8f54056a29b action.name=Dev action.run=r-f2e58cdec81b kind=action repo=b708d8f0629c worktree=/Users/alex/cf-actions-e2e.lUOL
$ $CF terminal close --id t-db62eb8c7091
closed terminal t-db62eb8c7091
```

A thread in a new worktree, with an on-worktree-create action, whose agent runs the CLI
(by absolute path: `~/.local/bin/code-foundry` is the installed older build):

```
$ $CF action add Setup --command 'echo "setup in $CODE_FOUNDRY_WORKTREE for thread $CODE_FOUNDRY_SESSION"; sleep 1' --icon configure --in-terminal=false --on-worktree-create
added action Setup (a-b95fb3b43066)
$ $CF session new --repo b708d8f0629c --new-worktree --name "Actions e2e" --model 'claude-haiku-5-5[1m]' --effort medium --permission auto --prompt "Run ... 1) $CF action run Test --background --wait   2) $CF terminal new --run 'echo hello from the agent'"
created thread Actions e2e (s-777b0263c648) in /private/tmp/cfa.npt5/worktrees/_local/cf-actions-e2e.lUOL/cf-actions-e2e (new worktree from main)
$ $CF action wait r-a739609864e5        # the hook's run
setup in /private/tmp/cfa.npt5/worktrees/_local/cf-actions-e2e.lUOL/cf-actions-e2e for thread s-777b0263c648
Setup exited with code 0 (run r-a739609864e5)
```

(The thread was first created with `claude-4.5-haiku[1m]`, the work laptop's Bedrock id,
which this machine's Claude does not have; it was switched with `thread set-model` and the
prompt re-sent.) The agent's reply:

```
Command 1 output (exit code 3):
root=/Users/alex/cf-actions-e2e.lUOL
worktree=/private/tmp/cfa.npt5/worktrees/_local/cf-actions-e2e.lUOL/cf-actions-e2e
pwd=/private/tmp/cfa.npt5/worktrees/_local/cf-actions-e2e.lUOL/cf-actions-e2e
to stderr
Test exited with code 3 (run r-7e555454d03f)

Command 2 output:
created terminal t-5a282fba486a and ran the command in it
```

```
$ $CF terminal list
t-5a282fba486a  running   /private/tmp/cfa.npt5/worktrees/_local/cf-actions-e2e.lUOL/cf-actions-e2e  kind=shell repo=b708d8f0629c session=s-777b0263c648 worktree=...
$ $CF action runs
RUN             ACTION  STATE     WHERE                    OWNER                            STARTED
r-7e555454d03f  Test    exited 3  background               thread s-777b0263c648            20:20:11
r-a739609864e5  Setup   exited 0  background               thread s-777b0263c648            20:19:50
...
$ CODE_FOUNDRY_SESSION=s-777b0263c648 $CF action run dev --wait
Dev exited with code 7 in terminal t-1a028f1547ff (run r-67c4e3ca0418)
$ $CF session remove --id s-777b0263c648 --yes
removed thread s-777b0263c648
$ $CF terminal list      # its shell and its exited action terminal are gone
ID              STATE     CWD                              LABELS
t-bf7852543c2e  exited 7  /Users/alex/cf-actions-e2e.lUOL  action=a-a8f54056a29b action.name=Dev action.run=r-f2e58cdec81b kind=action repo=b708d8f0629c worktree=/Users/alex/cf-actions-e2e.lUOL
$ $CF repo unregister --repo b708d8f0629c --yes
unregistered b708d8f0629c
$ $CF terminal list
ID  STATE  CWD  LABELS
$ $CF repo add ~/cf-actions-e2e.lUOL && $CF action list && $CF action runs
registered cf-actions-e2e.lUOL (b708d8f0629c)
no actions in this project (add one: code-foundry action add <name> --command '<command line>')
no action runs in this project since the daemon started
$ sqlite3 $CODE_FOUNDRY_HOME/db.sqlite 'select count(*) from actions'
0
```

## Gotchas

* Test helpers: `repotest.Fake` never writes the `repos` table, so the action store's
  tests insert repo rows themselves (the foreign key).
* `go build ./cmd/...` drops a `code-foundry` binary in the repo root; use `make build`.
* In a worktree whose libghostty-vt was never built, a bare `go test` can link against
  another worktree's cached library path. Use `make` targets, or export the Makefile's
  `PKG_CONFIG_PATH` and CGO flags.
* A proto `string` must be valid UTF-8; the store and the API both replace invalid bytes
  in run output (binary output otherwise fails the whole response).
