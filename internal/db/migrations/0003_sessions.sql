-- Claude sessions (internal/store/session). A row outlives its process: sessions are
-- listed as DISCONNECTED after a daemon restart and can be resumed with
-- `claude --resume <claude_session_id>`. Times are unix milliseconds. state mirrors
-- codefoundry.v1.SessionState (1 starting, 2 connected, 3 closing, 4 disconnected).
CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    claude_session_id TEXT NOT NULL DEFAULT '',  -- empty until the transcript is found
    repo_id           TEXT NOT NULL DEFAULT '',
    worktree_path     TEXT NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    auto_named        INTEGER NOT NULL DEFAULT 0,
    model             TEXT NOT NULL DEFAULT '',
    effort            TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    last_activity_at  INTEGER NOT NULL DEFAULT 0,
    parent_id         TEXT NOT NULL DEFAULT '',
    state             INTEGER NOT NULL,
    disconnect_reason TEXT NOT NULL DEFAULT '',
    exit_code         INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT NOT NULL DEFAULT ''
) STRICT;
