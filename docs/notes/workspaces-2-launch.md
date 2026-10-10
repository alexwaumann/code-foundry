# Workspaces step 2: thread owner, launch, "Run in…" (daemon)

Status: done on branch `cf/workspaces-store`. `make check` green. Exercised end to end on a
scratch daemon with real haiku threads (below). Design record: `workspaces-handoff.md`
(sections 2, 3, 5, 6, 7); step 1: `workspaces-1-store.md`. Steps 3–5 (composer, sidebar
and projects page, panel) are not started.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/session.proto` | `Session.workspace_id` (owner) and `pending_worktree_path`; `CreateSessionRequest.workspace_id` and `new_workspace` (`NewWorkspace{repos, base_ref, name}`); `SessionService.RunIn` |
| `internal/db/migrations/0008_session_workspace.sql` | `sessions.workspace_id TEXT NOT NULL DEFAULT ''` |
| `internal/store/session/workspace.go` | `WorkspaceSource`, member picking, new-workspace creation, launch additions (`workspaceLaunch`) |
| `internal/store/session/runin.go` | `Manager.RunIn` and the runner's queued `/cd` |
| `internal/store/session/newworktree.go` | slug wait shared by new-worktree and new-workspace mode (`waitSlug`); `pickBranch` checks several repos |
| `internal/claudestatus` | `Detector.AtPrompt()` |
| `internal/command/commands_session*.go` | `session new --workspace / --repos`, `session.run-in`; `session list` WORKSPACE column |
| `internal/daemon/stores.go` | workspace store opens before sessions; `session.Options.Workspaces` |
| `internal/store/workspace` | `ResolveRepo` exported (the session store resolves repo refs the same way) |

## Decisions

* **Owner rule** (proto comment on `Session`): `workspace_id` set means the workspace
  owns the thread, else the project `repo_id`. `repo_id` and `worktree_path` stay the
  cwd and never decide ownership. Existing rows have an empty `workspace_id` (project
  threads); no data migration. The owner is **explicit**: starting a thread with
  `--worktree <a member worktree>` and no `--workspace` makes a project thread, as the
  handoff says ("never a repo via its worktree"). Step 3's composer passes the
  workspace.
* **Workspace thread Create** (`workspace_id`, id or name): the cwd is the member
  `worktree_path` names (must be a member's worktree exactly, cleaned or
  symlink-resolved; a subdirectory is refused), else the member for `repo_id` (an id, or
  a repository name), else the first member. Both given must agree.
* **New-workspace mode** (`new_workspace`): repos resolve first (id, unique name, or a
  path, the workspace store's `ResolveRepo`), then the single slug wait
  (`Options.SlugTimeout`, the same `waitSlug` new-worktree mode uses, namer called once,
  a late name applied later), then `cf/<slug>` is picked free in **every** member
  (local and `origin`) and, when no name is given, free as a workspace name too
  (`-2`…`-9`, else `cf/<session id>`). The workspace store's `Create` makes every
  worktree (fetch first, pre-trust, all or nothing). The thread runs in `repo_id`'s
  member (id or name), else the first. `created_worktree` is set and `base_ref` is the
  cwd member's base. The workspace is named after the slug unless `new_workspace.name`
  is given. Exclusive with `new_worktree` and `workspace_id`.
* **Launch** (`spawn`, so create, reconnect and fork): the workspace's members come from
  the workspace store's snapshot at that moment, never the row. `--add-dir` for each
  other member whose worktree is an existing directory (claude refuses a missing one;
  logged), after the attachments `--add-dir`; env
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` appended to `Options.Env`; one
  `--append-system-prompt` line, exactly "This thread belongs to workspace <name>. Run
  `code-foundry workspace members` for the current worktrees." A workspace that no
  longer exists is logged and the thread starts without the additions. Project threads
  are unchanged (their env is still exactly `Options.Env`).
* **Fork** copies `workspace_id` and the cwd.
* **`session.run-in`** (`SessionService.RunIn`, CLI `session run-in <repo> --id <thread>`
  or `--worktree <path>`): refuses project threads, a target that is not a member, a
  member worktree that does not exist, and a closing thread. A **disconnected** thread's
  row moves at once (`claude --resume` finds the conversation from any cwd, and the
  transcript is in the new cwd's project dir anyway, see below). A **live** thread:
  `pending_worktree_path` is set (published, not persisted), the runner holds the
  request (latest wins; asking for the current member cancels), types `/cd <path>`
  when Claude is at its prompt, waits 400 ms, presses Enter, and only then writes
  `worktree_path`/`repo_id` and clears the pending path. A move still queued when the
  process ends is applied to the row.
* **"At its prompt"** is a new optional detector method, `AtPrompt()` (like `Input` and
  `Acknowledge`): idle, or needs-attention only because a finished turn (or an API
  error) has not been seen. Never with a dialog, notification, bell, unknown or busy.
  Without it the runner falls back to `StatusIdle`. The runner also waits until the
  first positional prompt has shown up in the transcript (or Claude was busy) and until
  `AtPrompt` has held for 1 s (see the gotcha below).
* **`session.new` availability**: still needs an active repo or worktree in the GUI, but
  is available from the CLI (empty `ActiveView`) without one, because `--workspace` or
  `--repos` alone are enough and `When` cannot see args. `Run` validates.
* **Store direction**: the session store imports `workspace` (types, `ResolveWorkspace`,
  `ResolveRepo`); the workspace store still never imports sessions (closures from the
  daemon). The daemon now opens the workspace store first; its `Threads`/`Trust`
  closures read `s.session`, set before anything can call them.

## Deviations from the handoff / brief

* **`--model claude-haiku-5-5`** is rejected by the CLI (`session new --model` is an
  enum of aliases). The e2e used `--model haiku`, which ran Haiku 5.5.
* **The pending-input mechanism**: `session.close` has no input queue; it is a request
  channel into the runner goroutine, which then writes keys. `RunIn` uses the same
  pattern (`cdReq`, capacity 1, latest wins), plus a timer for the Enter key.
* **`pending_worktree_path`** is an addition (not in the handoff) so the CLI and the
  step-4 GUI can show a queued move.
* **`session.run-in` shows in the GUI palette** for every thread (availability cannot
  see whether the active thread has a workspace); invoking it on a project thread
  fails with "does not belong to a workspace". Step 4 owns the GUI entry point.
* **Repository names** are accepted for `--repo` with `--workspace`, `--repos` and
  `run-in` (the brief said ids); ids still work.

## Gotchas

* **Typing too early.** With a positional first prompt, Claude draws its idle title
  (`✳`) before it submits the prompt, so the detector says "at prompt" for ~0.5 s after
  connect. The first e2e build typed `/cd` then: Claude showed it as a queued message
  ("ctrl+enter to send now"), ran the turn, then ran the `/cd` (it worked), but the row
  had moved several seconds early. Fixed by the first-prompt gate and the 1 s settle
  (`fix(session): type /cd only after …`).
* **Claude moves the transcript on `/cd`.** After `/cd`, the conversation's
  `<id>.jsonl` lives in the new cwd's `~/.claude/projects/<slug>` dir and the old dir is
  empty. It is a rename (same inode): the runner's open file keeps reading. The tailer's
  cwd is updated after `/cd` so it watches (and reopens in) the new dir; reconnect finds
  the file at the computed path for the new cwd.
* **A run-in leaves "finished" attention.** The `/cd` output counts as new work for the
  detector, so an unwatched thread shows needs-attention "finished" afterwards.
* **`/cd` output vs the status line.** Claude's footer kept showing the old
  `web:cf-e2e` until the next turn; the screen line `⎿ Moved to <path>` and `pwd` are
  the reliable signs.
* **The prompt line names `code-foundry`.** Inside the session that resolves through
  PATH (the install links `~/.local/bin/code-foundry`). The e2e daemon got a PATH entry
  with a link to the dev build; without it the session would have needed
  `$CODE_FOUNDRY_BIN`.
* `claude` auto-updated from 2.1.295 to 2.1.296 during the run ("Update installed");
  the findings are for 2.1.296.
* Paths with spaces in `/cd <path>` are typed unquoted; worktrees under
  `~/.code-foundry/worktrees` have none. Untested with spaces.

## `/cd` check (handoff section 6)

**No prompt.** On a pre-trusted member worktree, in auto mode (Claude Code 2.1.296,
Haiku 5.5): the runner typed `/cd /private/tmp/cf-ws2-7158/home/worktrees/_local/api/cf-e2e`
+ Enter at an idle prompt; the screen showed `⎿ Moved to …/api/cf-e2e` immediately, with
no trust dialog and no confirmation, and the detector reported no dialog. The next turn's
`pwd` printed the api worktree. The transcript records it as two `local_command` system
records plus a `<system-reminder>` that the working directory changed. Typed during a
turn, `/cd` is queued by Claude and runs after the turn, also without a prompt.

## End to end (scratch daemon)

`CODE_FOUNDRY_HOME=/tmp/cf-ws2-7158/home`, two scratch repos `web` and `api` (one commit
each, `<repo>-notes.txt`), daemon `--dev` with a PATH entry linking `code-foundry` to the
dev build, real `claude` (Alex's config, so trust went into `~/.claude.json` for the
scratch paths), threads `--model haiku --effort medium --permission auto`.

1. `workspace new e2e --repos web,api` → `cf/e2e` worktrees in both.
2. `session new --workspace e2e --repo web …` with "Run `code-foundry workspace
   members`, then list the files in the other member worktree…". Daemon log argv:
   `--add-dir …/attachments --add-dir …/api/cf-e2e --append-system-prompt This thread
   belongs to workspace e2e. Run `code-foundry workspace members` for the current
   worktrees. -- <prompt>`, cwd the web member. Inside the session `code-foundry
   workspace members` went over the loopback endpoint and printed both members with
   `(current)` on web; `ls` of the api member worked.
3. `session run-in api --id <that thread>` once it was idle: `/cd` as above, no prompt;
   `session list` showed the api worktree; a typed follow-up "Run pwd" printed the api
   path.
4. Probe thread in the web member, its prompt **not** naming the CLI or the workspace:
   "(1) which workspace this thread belongs to and the command that lists its
   worktrees, per your instructions; (2) the api codename, if a loaded CLAUDE.md names one; then use the Read
   tool on api-notes.txt in the api worktree". Answers: "Workspace: e2e. List its
   worktrees with code-foundry workspace members." (the appended line is honored);
   "PELICAN-42" (from a `CLAUDE.md` written into the api member before start, so
   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` works; haiku misattributed it to
   "this worktree"); `Read` of `…/api/cf-e2e/api-notes.txt` ran with no permission
   dialog (`--add-dir` covers the sibling).
5. `session new --new-worktree --repos web,api --repo api --prompt "Check the build: run
   echo one, then echo two…"` → namer slug `check-build-echo-sequence` in 1.6 s, workspace
   `check-build-echo-sequence` with `cf/check-build-echo-sequence` worktrees in both
   repos, thread in the api member. `session run-in web` issued right after create
   (thread busy): queued; the turn ended at :04.586, `/cd` typed at :06.412 and ran
   cleanly. (The first attempt, before the fix, is the "typing too early" gotcha.)
6. Daemon restarted (threads → disconnected, "daemon stopped"); `session reconnect` of the
   thread moved in step 3: `claude --resume <id> … --add-dir …/web/cf-e2e
   --append-system-prompt …`, cwd the api member, conversation restored.
7. Daemon log: no warnings or errors. Threads closed, daemon stopped, scratch home and
   the scratch `~/.claude/projects` dirs removed. The trust entries for the scratch
   paths stay in `~/.claude.json` (harmless).

## Verified

* `make check`: gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck, lint,
  668 vitest tests (no flake on this run).
* Tests: `TestPickMember`, `TestWorkspaceLaunch` (pure tables), `TestLaunchArgv` rows for
  `--append-system-prompt`; `TestCreateInWorkspace`, `TestCreateNewWorkspace` (branch
  free in any member, taken workspace name, explicit names, repo by name, refusals,
  nothing created on failure), `TestWorkspaceOwnerSurvivesRestartAndFork`,
  `TestWorkspaceThreadSpawn` (create, reconnect and fork read the current members; a
  missing member is skipped; env; project threads unchanged), `TestRunIn*` (refusals,
  waits for the prompt and for the first prompt, cancel, disconnected and
  exit-with-queued moves, persisted across restart), claudestatus `AtPrompt` steps, API
  and command rows, `session list` WORKSPACE column.

## Daemon restart

The installed daemon must be restarted to pick this up (new migration 0008, new RPC and
launch flags). Live threads are disconnected by the restart and resume with
`session reconnect`.
