-- Live subagent runs (internal/store/session/agents.go, docs/notes/agents-1-daemon.md):
-- each run's lifecycle as the stream's task frames report it, so the Agents panel keeps
-- finished runs across daemon restarts. status is running, done or failed; activity and
-- last_tool are the latest task_progress; total_tokens, tool_uses and duration_ms
-- Claude's counters (the latest request's tokens, tool uses and time summed over the
-- run's wakes); summary the report, error why it failed; resumed_at and ended_at unix ms
-- (0: never); note_item_id the thread item that announced a background run's end.
ALTER TABLE session_agent_runs ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN status TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN activity TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN last_tool TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_agent_runs ADD COLUMN tool_uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_agent_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_agent_runs ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN error TEXT NOT NULL DEFAULT '';
ALTER TABLE session_agent_runs ADD COLUMN resumed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_agent_runs ADD COLUMN ended_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_agent_runs ADD COLUMN note_item_id TEXT NOT NULL DEFAULT '';

-- Runs recorded before: a closed one reached its result; an open one was still followed
-- when the daemon last stopped, and its process is gone.
UPDATE session_agent_runs SET
    status = CASE WHEN open THEN 'failed' ELSE 'done' END,
    error = CASE WHEN open THEN 'the daemon restarted before the agent finished' ELSE '' END;
