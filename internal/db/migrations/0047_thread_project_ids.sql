-- Workspaces v2, the threads part (docs/notes/workspaces-v2-1-threads.md): a thread has a
-- project set, a JSON array of project ids sorted by id (the thread store reads and writes
-- it whole with the row, like labels; it normalizes the order and adds project_id on load).
-- Every thread's set is its own project_id. A thread of a v1 workspace (a branch set) gets
-- the workspace's members as its set and runs in worktree mode on the workspace's branch:
-- its members' derived checkouts are the member worktrees, which stay on disk where they
-- are. workspace_id stays, as a reference.
ALTER TABLE threads ADD COLUMN project_ids TEXT NOT NULL DEFAULT '[]';

UPDATE threads SET project_ids = json_array(project_id) WHERE project_id != '';

UPDATE threads SET
    project_ids = (
        SELECT json_group_array(project_id) FROM (
            SELECT project_id FROM workspace_members WHERE workspace_id = threads.workspace_id
            UNION SELECT threads.project_id WHERE threads.project_id != ''
            ORDER BY 1
        )
    ),
    branch = (SELECT branch FROM workspaces WHERE id = threads.workspace_id),
    created_worktree = 1
WHERE workspace_id != '' AND workspace_id IN (SELECT id FROM workspaces);
