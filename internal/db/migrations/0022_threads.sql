-- Threads were renamed from sessions (internal/store/thread, docs/notes/rename-session-to-thread.md):
-- the tables and the session_id columns follow. Column claude_session_id stays: it names
-- Claude Code's own session, which is Claude's word. SQLite rewrites the REFERENCES in the
-- child tables on RENAME TO (legacy_alter_table is off); the index is recreated by hand
-- because index names do not follow their table.
ALTER TABLE sessions RENAME TO threads;

ALTER TABLE session_pull_requests RENAME TO thread_pull_requests;
ALTER TABLE thread_pull_requests RENAME COLUMN session_id TO thread_id;
DROP INDEX session_pull_requests_session;
CREATE INDEX thread_pull_requests_thread ON thread_pull_requests (thread_id);

ALTER TABLE session_usage RENAME TO thread_usage;
ALTER TABLE thread_usage RENAME COLUMN session_id TO thread_id;

ALTER TABLE session_transcripts RENAME TO thread_transcripts;
ALTER TABLE thread_transcripts RENAME COLUMN session_id TO thread_id;

ALTER TABLE session_agent_runs RENAME TO thread_agent_runs;
ALTER TABLE thread_agent_runs RENAME COLUMN session_id TO thread_id;

ALTER TABLE session_source_usage RENAME TO thread_source_usage;
ALTER TABLE thread_source_usage RENAME COLUMN session_id TO thread_id;

ALTER TABLE session_thread_cache RENAME TO thread_cache;
ALTER TABLE thread_cache RENAME COLUMN session_id TO thread_id;

ALTER TABLE thread_items RENAME COLUMN session_id TO thread_id;
