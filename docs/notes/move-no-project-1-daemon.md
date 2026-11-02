# Move a No project thread, step 1: daemon, proto, CLI

PR 1 of 2 (the GUI is PR 2). A user starts a No project thread (cwd = home, empty
`project_id` and `workspace_id`) to look into something, then wants to keep working on it
inside a project or a workspace. `thread.project.add` and `thread.run-in` refuse such a
thread; `thread.move` takes it there.

## What landed

| Path | What |
|---|---|
| `internal/store/thread/move.go` | `Manager.Move`, `CheckMove`, the move job, naming, notes, rollback |
| `internal/store/thread/thread.go` | `MoveOptions`, `MoveTarget`, `Thread.PendingMove`, `Store.Move`, `CreateOptions.naming` (unexported hook) |
| `placement.go` | `placeWorktrees` calls `o.naming` instead of `waitNaming` when set |
| `naming.go` | `NamingRequest.Conversation` + `Branch`: the title-and-branch prompt over "Recent conversation:" |
| `runin.go`, `stream.go`, `runner.go` | `cdRequest.move`; `streamCd` applies or fails it; a runner that ends with a move queued fails it (never `movedTo`) |
| `claude.go`, `lifecycle.go`, `manager.go` | `launch.move` / `startOpts.move`: a start for a move gets the destination's argv; `Options.NewWorktreeDefault`; a queued move holds the idle stop |
| `transcript.go` | `tailer.relocated`: after `transcript_relocated` the tailer reopens the file at its new path and reads on from the same offset |
| `threadtest/fake.go` | `Fake.Move` |
| `proto/.../thread.proto`, `thread_lifecycle.proto` | `ThreadService.Move`, `MoveThreadRequest`/`Response`, `ThreadMove`, `Thread.pending_move = 75` |
| `internal/api/thread_move.go` | the handler, `moveToProto` |
| `internal/command/commands_thread_move.go` | `thread.move` (NoPalette) |
| `internal/daemon` | `NewWorktreeDefault` from `threads.default_worktree` |
| `internal/claudestream/fakeclaude` | set_cwd answers `transcript_relocated: true`; `CF_FAKE_CLAUDE_SET_CWD_REFUSE=<message>` refuses it |

## Decisions

* **Placement is Create's code.** `Move` builds a `CreateOptions` (project, worktree path,
  workspace, new worktree, checkout mode) and calls `placeThread` with no creator and no
  like, so the worktrees, `worktreeFor`'s refusals, `pickBranch`'s suffixes and fallback,
  shared worktrees, `mainCheckout`, the workspace primary rule and `rollback` are the
  ones a new thread gets. Nothing is applied to the row until Claude accepted `set_cwd`.
* **Default placement**: no `new_worktree`, `checkout_mode` or `worktree_path` →
  `Options.NewWorktreeDefault()` (the daemon reads `threads.default_worktree`: `new` is a
  fresh copy, `current` the project folder). The daemon decides, so the CLI and the GUI
  agree.
* **Naming.** One explicit naming call (`regenerateCall`, so `threads.auto_name` does not
  turn it off; `threads.naming_model` applies) with the thread's recent turns
  (`recentTurnsContext`, as Regenerate name) and, for a new branch that needs the model
  (`branchChoice.branchRequest`), the branch request: the prompt is the title-and-branch
  one with "Recent conversation:" in place of "Request:". The branch follows
  `projects.branch_naming` exactly as thread.new (composeBranch, pickBranch, `cf/<id>`
  fallback, `-2..-9`). A verbatim or existing branch asks for the title only. The title
  replaces any name (typed too) and is applied with the move; the wait is
  `SlugTimeout`. No conversation, a failed call, or a timeout: the name stays and the
  branch falls back; a late title is applied if the thread has moved by then.
  `Thread.naming` is on while the call runs.
* **set_cwd always, never a file move.** Running at its prompt: the job goes on RunIn's
  queue (`cdReq`, `tryCd` after `cdSettle`) and the call waits for the answer (up to 45 s,
  then it returns the thread still moving). Mid-turn (status busy, a pending request, a
  wake pending): the call returns at once with `pending_move` and
  `pending_worktree_path` set. Not running: `startStopped` with `startOpts.move`, so the
  process starts in home with `--resume` and the destination's `--add-dir` list and
  system prompt (`claudeCommand` over `s.withMove(job)`), then the same queue; the call
  waits. A thread that never had a conversation (no Claude session id) has nothing to
  relocate: the row moves at once, no process starts.
* **Auto-stop after a move start**: the process started for the move has its
  `startedAt` cleared once it moved, so the start grace (`IdleGrace`) does not hold it:
  it stops at its cache expiry, or at the stopper's next pass when that passed already.
* **Workspaces**: a running Claude moved into a workspace (or a set of more than one
  project) gets `dirsStale`, so `maybeRestart` restarts it, resuming from the new cwd
  (`respawn` uses `r.cwd`, which `streamCd` moved, and finds the relocated transcript
  there), with the members and the workspace's folder as `--add-dir`. A started process
  has them already and does not restart.
* **Failure leaves the thread unchanged**: a refusal before the claim (has a project,
  archived, resident, transcript missing, a move under way, no place, unknown project or
  workspace), a placement refusal (nothing made, or `makeWorktrees` rolled back), a start
  that fails, a refused set_cwd, a checkout gone before the queue ran, or Claude stopping
  with the move still queued (archive, crash, daemon stop): the worktrees the move made
  are removed with their new branches (`rollback`), `pending_move` clears, `last_error`
  says why, and the timeline gets "Could not move this thread to <place>: <why>. It stays
  where it was, without a project." A process started for a failed move is stopped (it
  has the destination's folders as `--add-dir`). A transcript that is gone is refused up
  front and sets `transcript_missing`.
* **Timeline note on success**: "Moved this thread to <project> (new worktree on
  <branch>)." / "(new worktree on existing branch <b>)" / "(worktree <path> on <b>)" /
  "(<path>)"; a workspace is "workspace <name>". The project's on-worktree-create actions
  run for the worktrees it made (`WorktreeCreated`), as after Create.
* **Scope**: only a thread without a project or workspace (`CheckMove`). Moving a thread
  that has one stays refused.
* **The CLI**: `code-foundry thread move <to> [--id] [--project] [--workspace]
  [--worktree] [--new-worktree[=false]] [--base] [--branch]`. `<to>` is a project
  (resolved by the registry's project resolver) unless none answers to it, then a
  workspace (the daemon says when it is neither); with `--workspace`, `<to>` is the
  primary (`workspace` for its folder). No `--base-from-origin` (the setting applies;
  the guide has no room). NoPalette: PR 2 adds the picker's command.

## For the GUI (PR 2)

* RPC `ThreadService.Move(MoveThreadRequest)`: `id`, `project_id`, `worktree_path`,
  `workspace_id`, `new_worktree` (`NewWorktree{base_ref, branch, base_from_origin}`),
  `checkout_mode`, the names and meanings of `CreateThreadRequest`'s. The composer's
  choices map 1:1: fresh copy = `new_worktree{base_ref}`; existing branch =
  `new_worktree{branch}`; project folder = `checkout_mode`; an existing worktree =
  `worktree_path`; a workspace = `workspace_id` with `project_id` the primary member or
  `"workspace"`. None of them: `threads.default_worktree`.
* `MoveThreadResponse`: `thread`, `made_worktree`, `made_branch`, `existing_worktree`,
  `shared_with`, `hints` (as Create's).
* "Moving…": `Thread.pending_move` (`ThreadMove{project_id, workspace_id, worktree_path,
  branch}`), set from the call until set_cwd answered or the move failed; `project_id`
  (else `workspace_id`) names the place; path and branch are empty until the placement is
  made. `pending_worktree_path` is set too once queued. `naming` is on while the name is
  being generated. The thread's own `project_id`/`workspace_id` change only when it moved.
* Errors: `FAILED_PRECONDITION` for every refusal (with project, archived, resident,
  transcript missing, already moving, stopping/starting, placement refusals, set_cwd
  refused), `INVALID_ARGUMENT` for no place or both modes, `NOT_FOUND` for an unknown
  project or workspace. A move that fails after a mid-turn return shows only in the
  timeline, `last_error`, and `pending_move` clearing.
* Command `thread.move` (args `id`, `to`, `project`, `workspace`, `worktree`,
  `new-worktree`, `base`, `branch`) is NoPalette; the mock (`gui/frontend/mock`) does not
  implement Move yet.

## Gotchas

* The env namer in the store tests reads `req.Message`; a move's request has only
  `Conversation`, so `move_test.go` uses its own namer (`moveNamer`).
* `runner.finish` used to apply a queued RunIn to the row when the process ended; a
  queued move must not be applied that way (the transcript was never relocated), so it
  fails instead.
* A queued move now holds the idle stop (`messageOnItsWay`), so an idle stop cannot cut a
  move that is about to happen.
* The guide was at its cap (25,650 bytes, `internal/guide/topics_test.go`). `thread.move`
  is in it with short descriptions; `--base-from-origin` was left out and
  `thread.run-in`'s description shortened (25,646).
* Run in's Claude answers now carry `transcript_relocated` in the fake; the tailer's
  `relocated` is a no-op when the transcript resolves to the path it already has.

## Found with real Claude (fixed in this PR)

* **A running Claude answers `needs_trust`** to set_cwd for a folder trusted after it
  started (it reads folder trust at start; the pre-trust the move writes comes too late
  for it). The first version failed the move (it rolled back cleanly: the thread stayed
  in home, the timeline said "needs_trust"). Now `streamCd` restarts that process once
  (`runner.moveRestart`: resuming, still in the old cwd, with the destination's
  `--add-dir` list, so it rereads its config), then sends set_cwd again; a second
  `needs_trust` fails the move. A worktree the daemon already trusted before the process
  started (the workspace case below) moves without it.
* `thread move <name>`: the registry's project resolver passes an unknown ref through,
  so a workspace name reached the daemon as a project (NOT_FOUND). The command now
  retries a project NOT_FOUND as a workspace and says "no project or workspace" when it
  is neither.

## Observed, not changed

* Claude emits an empty `result` (0 tokens, ~20 ms) right after a set_cwd, which the
  timeline shows as a 0.0 s turn end. A plain `thread run-in` does the same, so it is
  existing behaviour, left for a follow-up (it may set a moved thread's status to
  "finished").

## Verified with real Claude

`make build`; `CODE_FOUNDRY_HOME=/tmp/cf-move bin/code-foundry daemon --dev`; scratch git
repos `~/cf-move-scratch/movedemo` and `movelib` (each with a local bare origin), `project
add` both, `workspace new duo --projects movedemo,movelib`. Threads on
`claude-sonnet-5-5[1m]` at medium effort. The default naming model (Sonnet 4.6 [1m]) was
refused by the account ("Usage credits required for 1M context"), so the scratch daemon
had `threads.naming_model = claude-sonnet-5-5[1m]`.

1. Not running, fresh copy:
   `thread new --no-project --model 'claude-sonnet-5-5[1m]' --effort medium --created-by=
   --prompt "The login page redirects to /home after sign-in instead of the page the user
   came from. Remember the word PELICAN for later. …"`, then `thread archive` and
   `thread archive --archived=false` to stop it. Transcript at
   `~/.claude/projects/-Users-alex/37632434-….jsonl`.
   `thread move movedemo --id s-1df6187039ec --new-worktree` (6.9 s, naming included):
   "moved thread Fix login redirect destination (s-1df6187039ec) to movedemo, in
   /private/tmp/cf-move/worktrees/_local/movedemo/fix-login-redirect-destination (new
   worktree on fix/login-redirect-destination from origin/main)". Log: "started thread to
   move it" with `--resume 37632434-…` and `cwd=/Users/alex`, then "thread moved …
   transcript_relocated=true". The transcript was then only at
   `~/.claude/projects/-private-tmp-cf-move-worktrees--local-movedemo-fix-login-redirect-destination/37632434-….jsonl`.
   Timeline: "Moved this thread to movedemo (new worktree on fix/login-redirect-destination)."
   `thread send --wait "What word did I ask you to remember, and what bug did I describe?
   Also print your current working directory with pwd."`: same process (no new spawn),
   `pwd` = the worktree, "The word was PELICAN, and the bug is that the login page
   redirects to /home after sign-in instead of the page the user came from."
   With `threads.cache_ttl_seconds = 60` it stopped by itself ("stopping idle thread at
   its prompt cache expiry", reason idle) about two minutes after the move's start: the
   five-minute start grace did not hold it.
2. Not running with an expired cache, project folder: `thread move movedemo --id
   s-3294216254ec --new-worktree=false` → "in /Users/alex/cf-move-scratch/movedemo",
   transcript_relocated=true, stopped (idle) 25 s later at the stopper's next pass.
3. Running and idle, project folder (`threads.default_worktree = current`, no flag):
   `thread move movelib --id s-faa8827605a5` → the needs_trust restart above
   ("claude needs the move's folder trusted; restarting it…", "claude restarted" with
   `--resume`), then "thread moved … transcript_relocated=true"; 3.5 s.
4. Workspace, running and idle: `thread move duo --id s-6e25e6d49a07 --new-worktree` →
   "to workspace w-46b6b35a4a96, in …/movedemo/refactor-share-version-constant (new
   worktree on refactor/share-version-constant from origin/main)"; worktrees made in both
   members on the one branch, `checkout_paths` has both; set_cwd ok
   (transcript_relocated=true), then "restarting claude for a changed project set" and
   "claude restarted" with `--resume 13505c19-…`, `--add-dir
   /tmp/cf-move/workspaces/w-46b6b35a4a96` and `--add-dir …/movelib/refactor-share-version-constant`.
   A send afterwards: "You asked me to remember MANGO", `pwd` = the movedemo worktree.
5. Mid-turn: a thread running `sleep 20` (busy tool "Bash sleep 20"); `thread move movelib
   --new-worktree` returned at once: "moves to …/movelib/chore-run-sleep-command once its
   turn ends"; `thread get`: status busy, `worktreePath` /Users/alex, `pendingMove
   {projectId, worktreePath, branch: chore/run-sleep-command}`. The move happened 20 s
   later, as the turn ended.
6. Daemon log: no warnings or errors besides the refused naming model and the needs_trust
   failure of the first version. Scratch repos, `/tmp/cf-move` and the test transcripts
   removed.

## Tests

* Store (`move_test.go`): `TestCheckMove` (table), `TestMoveStoppedIntoNewWorktree`
  (start in home with `--resume`, set_cwd, row, report, naming request with the
  conversation and a branch, note, WorktreeCreated, no start grace, next start in the
  worktree), `TestMoveLiveIntoProjectFolder` (no restart), `TestMoveMidTurnWaitsForTheTurn`
  (pending move, a second move refused), `TestMoveLiveIntoWorkspace` (the restart with the
  members, resumed, cwd), `TestMoveStoppedIntoWorkspaceFolder` (the start's add-dirs),
  `TestMoveOntoExistingBranch` (base ignored, title only), `TestMoveSetCwdRefusedRollsBack`,
  `TestMoveRefusals` (project, no place, both modes, unknown project, main checkout on the
  branch, archived, transcript missing), `TestMoveWithoutConversation` (row only, setting
  default, `cf/<id>`), `TestMoveNamingFails`, `TestMoveQueuedLostWhenClaudeStops`,
  `TestMoveLiveRestartsForTrust`; `TestBuildNamingPromptConversation` rows;
  `TestTailerFollowsARelocatedTranscript`.
* API `TestThreadMove`; command `TestThreadMove` (placement flags, workspace fallback,
  queued message, refusals); the command and NoPalette lists.
