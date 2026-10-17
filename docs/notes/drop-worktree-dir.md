# Drop projects.worktree_dir

Decided by Alex on 2026-10-17: where worktrees go is the app's call, not the user's.
Every worktree the app makes lives at `<config home>/worktrees/<owner>/<repo>/<branch>`
(`_local/<name>` in place of owner/repo without a GitHub origin), the project store's
`WorktreeRoot` layout.

## What went

- The `projects.worktree_dir` setting (Settings › Source control › Projects, "Worktree
  directory") and its `{project}` / `{repo}` placeholder expansion.
- The daemon's hooks that applied it: `settingsWorktreePath`, the `worktreeDirProject`
  wrapper around `project.worktree.new`, `worktreePath`, `worktreeBase`,
  `settingsManagedRoots`.
- `project.Options.ManagedRoots`: `WorktreeRoot` is the only managed root, so
  `Worktree.Managed` is `InsideRoot(path, wtRoot)`.
- `thread.Options.WorktreePath` and `workspace.Options.WorktreePath`: a new thread's
  worktree and a workspace member's take the project store's path.
- `CreateWorktreeRequest.path` (field 4, now reserved with its name) and
  `project.CreateWorktreeOptions.Path`. No CLI verb or GUI caller set it
  (`project.worktree.new` never had `--path`).

## Old settings files

`settings.decode` drops `retiredKeys` (`projects.worktree_dir`, and `repos.worktree_dir`
from before the repo -> project rename) after renaming legacy keys, so a file that
still sets it reads with no "unknown setting" issue on the Settings page. The next save
renders only known fields, so the key leaves the file then. Nothing is migrated on disk
at load.

## No migration for existing worktrees

Worktrees previously made under a custom `worktree_dir` stay where they are and keep
working (threads, shells and git status do not care where a worktree lives), but they
stop counting as managed: Clean up skips them with "not a Code Foundry worktree". Alex
chose this over moving them or keeping the old root as a managed root.

## Gotchas

- The `Path` settings field type is still used (claude and gh executable paths), so it
  stays.
- The project store's own explicit-path test now checks the default layout instead.
