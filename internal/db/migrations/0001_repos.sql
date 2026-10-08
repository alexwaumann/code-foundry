-- Registered repositories (internal/store/repo). Worktrees and status are derived from
-- the repository on every start and are not persisted.
CREATE TABLE repos (
    id            TEXT PRIMARY KEY,           -- sha1(main worktree path), hex, truncated
    path          TEXT NOT NULL UNIQUE,       -- main worktree path (symlinks resolved)
    name          TEXT NOT NULL,              -- display name, basename of path
    registered_at INTEGER NOT NULL            -- unix milliseconds
) STRICT;
