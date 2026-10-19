# Dirty worktree confirm: ask before deleting uncommitted work

Status: branch `cf/dirty-worktree-confirm`. Agreed with Alex 2026-10-19: a worktree with
uncommitted changes is no longer a hard refusal for `project.worktree.remove`,
`project.worktree.cleanup` (one path or bulk), `workspace.remove-project` and
`workspace.remove`. The user is asked whether it is okay to delete that work, with the
counts. A live thread in the worktree (and, for cleanup, a running terminal or a workspace
holding it) is still a hard refusal.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/command.proto` | `ConfirmationRequired.args` (merge on re-invoke) and `.declined` (the result that stands when the user says no) |
| `proto/codefoundry/v1/project.proto` | `CleanupWorktreesRequest.force`, `RemovedWorktree.uncommitted`, `SkippedWorktree.uncommitted`, the `UncommittedWork` error detail |
| `internal/store/project/uncommitted.go` | `Status.HasUncommitted`, `*UncommittedError` (wraps `ErrFailedPrecondition`) |
| `internal/store/project/store.go` | `RemoveWorktree` without force: when git refuses, the worktree's status is read again and a dirty one fails with `*UncommittedError` |
| `internal/store/project/cleanup.go` | `CleanupOptions.Force`, `CleanupItem.Uncommitted`, `UncommittedReason` |
| `internal/store/workspace/store.go` | `Remove`'s dirty-member check returns `*project.UncommittedError` naming every dirty member (with status) |
| `internal/api/uncommitted.go` | `projectError` and `workspaceError` attach `UncommittedWork` when the error wraps `*project.UncommittedError` |
| `internal/api/command.go` | `ConfirmError.Args` and `.Declined` into the detail |
| `internal/command/confirm.go`, `uncommitted.go` | `ConfirmError.Args`/`.Declined`; `uncommittedOf`, `changeCounts`, `deleteWorkConfirm` |
| `internal/command/commands_project.go`, `commands_workspace.go`, `commands_project_cleanup.go` | the second stage in the four commands; `force` on cleanup; descriptions say what `--yes` does |
| `cmd/code-foundry/confirm.go` | the CLI's prompt loop (up to 3 stages), args merge, the `--yes` rule |
| `gui/frontend/src/api/command.ts`, `stores/commands.ts` | `ConfirmationView.args`/`.declined`; `invokeConfirmed` loops, merging args |

## Flow

Every command keeps its own first question ("Remove worktree /x? This deletes files on
disk."). Confirmed, it runs without force. When the backend refuses only for uncommitted
changes, the command returns a second `ConfirmError`: title "Delete Uncommitted Work",
a message naming each worktree (branch, path, counts such as "2 modified, 1 untracked")
that says the work is deleted for good, and `args {"force": "true"}`. The client asks
again; yes re-invokes with the args merged and `confirmed` set, and the removal runs with
force. So the user always sees the counts before anything uncommitted goes, and always in
a second, separate dialog.

One behaviour for all four commands: two dialogs. I did not fold the counts into the
first prompt where a dry run already knows (cleanup's DynamicConfirm). The dry-run prompt
lists them ("Also removable if their uncommitted work is deleted (you are asked again
first):") but setting force from the first prompt would make cleanup the odd one out, and
the run re-checks after a fetch anyway.

Bulk cleanup: the normal run removes the clean, merged worktrees. If any were kept only
for uncommitted changes, the second stage starts with what was removed ("Removed 1
worktree: cf/a."), lists each dirty one with its counts and asks. The forced re-run
fetches again and removes them; the clean ones are already gone, so it is idempotent.
`force` relaxes only the uncommitted rule: a worktree is marked `uncommitted` when
`CleanupVerdict` of the same worktree with its changes set aside is removable (so every
other condition passes) and the Hold has nothing. A held, unmerged, fresh, unmanaged,
detached or mid-rebase worktree is never marked and never forced.

## Decisions

* **Generic escalation, not a cleanup special case.** `args` on `ConfirmationRequired` is
  the whole mechanism. The daemon cannot tell `--yes` from a GUI yes (both send
  `confirmed`), so the rule lives in the clients: a confirmation with args is never
  answered on the user's behalf.
* **`declined` (an addition to the agreed design).** Bulk cleanup has already removed the
  clean worktrees when it asks the second question. Without `declined`, saying no in the
  GUI would show nothing, and `cleanup --yes`, which agents run after every merge
  (`code-foundry-orchestrate` SKILL.md), would start failing whenever a merged worktree
  had a stray untracked file. With `declined`, the run's normal result ("Removed 1
  worktree: …; kept 1 worktree: cf/d (uncommitted changes)") is the answer when the user
  says no, or when `--yes` cannot answer. `cleanup --yes` behaves exactly as before.
  The one-target commands have no `declined`: nothing was done, so `--yes` fails as it did
  before (exit 2, as the old FailedPrecondition did), now pointing at `--force`.
* **The `--yes` line.** `--yes` answers the command's own question only. A second stage
  under `--yes` (or with no terminal): with `declined`, the CLI prints that result (exit
  0) plus a stderr note that `--force` would have deleted the work; without it, the CLI
  prints the message and "--yes does not answer this; re-run with --force to." (exit 2).
  Agents must pass `--force` on purpose. The command descriptions say so (`forceNote`).
* **Where the counts come from.** `git worktree remove` is still the judge for the one-
  target removals: the project store tries without `--force` and, only when git refuses,
  reads that worktree's status again (one status job, not a project refresh) and returns
  `*UncommittedError` if it has changes. Any other refusal (locked worktree) passes
  through unchanged. `workspace.remove` refreshes every member first, as before, so
  nothing is removed when one is dirty; with the second yes it removes them all.
* **A second stage applies only to the command invoked.** If `ConfirmationRequired.command`
  is another command (`plugin.act` pressing a button whose command asks again), the GUI
  rejects with the error and the CLI says to run that command itself: the args are not
  the outer command's to merge. Plugin presenters (`confirmPresenter`) are not used for a
  second stage; it always shows in the generic dialog.
* **Plugins.** `pluginsdk` is unchanged. `host/invoke` still maps any `ConfirmError` to
  `CodeConfirmationRequired` with `{"message": …}`; a plugin never confirms, so it never
  reaches a second stage. `confirm: ask` hands the command to the GUI, whose
  `invokeConfirmed` runs both stages. The proto change is two optional fields.
* **Race.** Counts are what git reported when the second question was raised. Work
  added between that dialog and the forced re-run is deleted too; I did not pin counts
  in the args (an expected-count check would mean another refusal path for little gain).
* **"Removable with force" includes a worktree with no commits since it was made** (older
  than 10 minutes), i.e. work that never got committed anywhere. That is the agreed rule
  ("every other condition passes"); the second dialog shows its counts, and the reason
  line says so.

## Gotchas

* `projecttest.Fake.RemoveWorktree` now refuses a worktree whose status has uncommitted
  changes without force, as git does. `workspacetest.Fake.Uncommitted` makes the
  workspace removals refuse the same way.
* The GUI's per-row "Clean up" action and the project's Clean up button still count only
  `merged_clean` worktrees, so a merged but dirty worktree is reached through Remove
  worktree…, or through bulk cleanup when at least one clean one exists. Surfacing
  "cleanable if deleted" in the Projects page is a possible follow-up.
* The confirm dialog's destructive button keeps autofocus, so Enter answers the second
  question too. Both dialogs differ in title and text; I left focus as it is everywhere.

## Verified

See the PR body for the end-to-end runs (daemon + CLI, daemon + GUI) and screenshots.
