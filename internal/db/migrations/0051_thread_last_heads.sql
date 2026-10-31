-- The branch each of a thread's worktree-mode checkouts had checked out when a cleanup
-- removed it (docs/notes/recreate-last-head.md): a JSON object {project_id: branch} the
-- thread store writes whole with the row (as checkouts). A checkout's HEAD is otherwise
-- read live from the project snapshot, which forgets it once the worktree is gone; a
-- start that makes the worktree again checks out this branch when it still exists, then
-- drops the entry. '' (every row before) is nothing recorded: recreate uses the
-- created-for branch (threads.branch), as before.
ALTER TABLE threads ADD COLUMN last_heads TEXT NOT NULL DEFAULT '';
