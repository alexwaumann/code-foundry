-- Session usage, sources (internal/store/session/usage_runs.go, docs/notes/session-usage.md).
-- A thread's usage is the sum of its sources: every transcript file it has used (a
-- /clear moves Claude to a new one) and every subagent run under them.

-- The Claude session ids (transcript files) a thread has used, oldest first (seq).
CREATE TABLE session_transcripts (
    session_id        TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    claude_session_id TEXT NOT NULL,
    seq               INTEGER NOT NULL,
    PRIMARY KEY (session_id, claude_session_id)
) STRICT;

-- A thread's subagent runs (<project dir>/<claude_session_id>/subagents/agent-<agent_id>.jsonl).
CREATE TABLE session_agent_runs (
    session_id        TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    agent_id          TEXT NOT NULL,
    claude_session_id TEXT NOT NULL,  -- the transcript whose subagents/ directory holds the run
    tool_use_id       TEXT NOT NULL,  -- the Agent tool_use that spawned it ('' if unknown)
    description       TEXT NOT NULL,
    agent_type        TEXT NOT NULL,
    model             TEXT NOT NULL,  -- as requested: "haiku", "opus", '' (inherited)
    effort            TEXT NOT NULL,
    spawn_depth       INTEGER NOT NULL,
    background        INTEGER NOT NULL,
    open              INTEGER NOT NULL, -- still followed when last saved
    started_at        INTEGER NOT NULL, -- unix ms of the run's first record; 0 if unknown
    PRIMARY KEY (session_id, agent_id)
) STRICT;

-- The last complete fold of each source, so a source whose file Claude has since
-- deleted (cleanupPeriodDays) keeps its counters on the next rescan. source is
-- 't:<claude session id>' (a transcript's own records) or 'a:<agent id>' (a run).
-- Rows are replaced whole per source; session_usage stays the thread's total.
CREATE TABLE session_source_usage (
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    source         TEXT NOT NULL,
    model          TEXT NOT NULL,
    tier           TEXT NOT NULL,
    speed          TEXT NOT NULL,
    day            TEXT NOT NULL,
    requests       INTEGER NOT NULL,
    input          INTEGER NOT NULL,
    output         INTEGER NOT NULL,
    cache_read     INTEGER NOT NULL,
    cache_write_5m INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL,
    PRIMARY KEY (session_id, source, model, tier, speed, day)
) STRICT;

-- Until now a thread's usage was the fold of its current transcript only: seed that
-- file as its first source.
INSERT INTO session_transcripts (session_id, claude_session_id, seq)
    SELECT id, claude_session_id, 0 FROM sessions WHERE claude_session_id != '';
INSERT INTO session_source_usage
    SELECT u.session_id, 't:' || s.claude_session_id, u.model, u.tier, u.speed, u.day, u.requests, u.input,
           u.output, u.cache_read, u.cache_write_5m, u.cache_write_1h
    FROM session_usage u JOIN sessions s ON s.id = u.session_id WHERE s.claude_session_id != '';
