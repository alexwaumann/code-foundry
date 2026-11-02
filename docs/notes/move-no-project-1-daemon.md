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
