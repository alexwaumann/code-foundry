-- A thread owns its checkouts (docs/notes/thread-checkouts.md): the path of every member
-- of its project set, a JSON object {project_id: path} the thread store reads and writes
-- whole with the row (as project_ids). What each checkout has checked out is read from it
-- (HEAD), not from the row; threads.branch stays as the branch the thread was created for.
-- '' is "not recorded yet": the daemon fills every such row at its next start from the
-- derivation it replaces (a member's worktree on the thread's branch, else its own
-- checkout), once the projects have listed their worktrees, which SQL cannot read; a
-- member whose worktree is missing then gets '' and is made at the thread's next start.
ALTER TABLE threads ADD COLUMN checkouts TEXT NOT NULL DEFAULT '';
