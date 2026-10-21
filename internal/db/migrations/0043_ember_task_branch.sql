-- The branch a task's worker pushed (internal/store/ember, docs/notes/ember-fixes-2-tasks.md):
-- recorded by `ember task done --branch` once origin/<branch> was seen in the worker's
-- worktree, and printed by the board, `ember task show` and the GUI's card. '' for none,
-- the value of every existing row.
ALTER TABLE ember_tasks ADD COLUMN branch TEXT NOT NULL DEFAULT '';
