-- Workspaces v2, the workspaces part (docs/notes/workspaces-v2-2-workspaces.md): a
-- workspace is a saved project set with a managed dir, no branch and no worktrees. The
-- branch goes; root_path (a rooted workspace's folder, '' for a synthetic one) and
-- default_primary (a member project id, or 'workspace') come; the default primary is the
-- first member added. Members lose their worktree path: the v1 member worktrees stay on
-- disk and are exactly the derived checkouts of the threads migration 0047 moved onto the
-- workspace's branch. Managed dirs are made at the first daemon start after this.
ALTER TABLE workspaces DROP COLUMN branch;
ALTER TABLE workspaces ADD COLUMN root_path TEXT NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN default_primary TEXT NOT NULL DEFAULT '';

UPDATE workspaces SET default_primary = COALESCE((
    SELECT project_id FROM workspace_members m WHERE m.workspace_id = workspaces.id
    ORDER BY added_at, rowid LIMIT 1
), 'workspace');

-- worktree_path is UNIQUE, which DROP COLUMN refuses: the table is made again.
CREATE TABLE workspace_members_v2 (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL,
    added_at     INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, project_id)
) STRICT;
INSERT INTO workspace_members_v2 (workspace_id, project_id, added_at)
    SELECT workspace_id, project_id, added_at FROM workspace_members;
DROP TABLE workspace_members;
ALTER TABLE workspace_members_v2 RENAME TO workspace_members;
