-- Worktrees the app made (internal/store/project, docs/notes/cleanup-eligibility.md): the
-- project store records each one CreateWorktree adds, and only those can be cleaned up.
-- A worktree under the worktrees directory that no row knows (an agent's own
-- `git worktree add`) is "not a Code Foundry worktree". A row goes when the worktree is
-- removed through the store or a reconcile no longer lists it; it outlives Unregister,
-- so a project registered again keeps its worktrees' rows. head is HEAD right after the
-- worktree was made ('' when unknown), created_at unix milliseconds: together they tell
-- a worktree made a moment ago with no commits yet, which cleanup keeps.
CREATE TABLE project_worktrees (
    path       TEXT PRIMARY KEY,             -- symlinks resolved, as in the snapshot
    project_id TEXT NOT NULL,
    head       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
) STRICT;

-- Worktrees made before this table: every thread row that made its worktree (archived
-- ones included). Worktrees made by project.worktree.new without a thread were not
-- recorded anywhere and stay unknown (never cleaned up; removable by hand).
INSERT INTO project_worktrees (path, project_id, head, created_at)
SELECT worktree_path, project_id, '', MIN(created_at)
FROM threads
WHERE created_worktree = 1 AND worktree_path != '' AND project_id != ''
GROUP BY worktree_path;
