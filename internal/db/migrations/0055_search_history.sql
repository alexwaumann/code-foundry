-- The search dialog's history (docs/notes/search-5-agent-daemon.md): the last 50
-- searches of its two modes, newest first. An agent search (mode 'agent') keeps its run:
-- status, answer, the accepted hits and the progress steps (JSON arrays), the Claude
-- session it ran in (Promote continues it), its cost and time, and whether the GUI has
-- shown its finished result (unseen). A Find entry (mode 'find') keeps its query only.
CREATE TABLE search_history (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    query TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    answer TEXT NOT NULL DEFAULT '',
    hits TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL DEFAULT '[]',
    claude_session_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    unseen INTEGER NOT NULL DEFAULT 0,
    promoted_thread_id TEXT NOT NULL DEFAULT ''
);
