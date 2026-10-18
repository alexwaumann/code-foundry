-- The branch a thread's worktree was made for (internal/store/thread/recreate.go,
-- docs/notes/recreate-worktree.md): set when Create makes the worktree (a new worktree or
-- a new workspace) and copied by Fork, so a thread whose worktree a cleanup removed can
-- have it made again at the same path when it resumes. '' when the app did not make the
-- thread's worktree; existing rows are filled in at startup from the project store while
-- their worktree still exists.
ALTER TABLE threads ADD COLUMN branch TEXT NOT NULL DEFAULT '';
