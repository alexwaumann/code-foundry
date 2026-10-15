-- What a thread's Claude last reported about itself, kept while it is not running
-- (internal/store/session/threadcache_db.go, docs/notes/thread-lifecycle.md): the slash
-- commands of its initialize reply and commands_changed pushes (after the deny table),
-- and its MCP servers' last check, each as JSON ('' when Claude never reported them).
-- The daemon stops idle threads at their prompt cache expiry and starts them again on
-- the next message, so the composer's "/" card and the MCP panel read these meanwhile.
-- The next process replaces them.
CREATE TABLE session_thread_cache (
    session_id     TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
    slash_commands TEXT NOT NULL DEFAULT '',
    mcp_status     TEXT NOT NULL DEFAULT ''
) STRICT;
