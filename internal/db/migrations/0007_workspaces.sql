-- Workspaces (internal/store/workspace): one branch checked out as a worktree in each
-- of several repositories. Times are unix milliseconds. A repository is in a workspace
-- at most once, and a worktree belongs to at most one workspace.
CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,          -- "w-" + 12 hex digits
    name       TEXT NOT NULL UNIQUE,
    branch     TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspace_members (
    workspace_id  TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    repo_id       TEXT NOT NULL,
    worktree_path TEXT NOT NULL UNIQUE,
    added_at      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, repo_id)
) STRICT;
