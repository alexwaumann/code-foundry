-- Session usage (internal/store/session/usage.go, docs/notes/session-usage.md): token
-- counters folded from each thread's transcript, one row per (model, tier, speed, UTC
-- day). A session's rows are always replaced whole (delete + insert in one
-- transaction) by a complete fold; nothing is ever added to them.
CREATE TABLE session_usage (
    session_id     TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    model          TEXT NOT NULL,
    tier           TEXT NOT NULL,  -- '' or 'long'
    speed          TEXT NOT NULL,  -- '' or 'fast'
    day            TEXT NOT NULL,  -- UTC "YYYY-MM-DD"
    requests       INTEGER NOT NULL,
    input          INTEGER NOT NULL,
    output         INTEGER NOT NULL,
    cache_read     INTEGER NOT NULL,
    cache_write_5m INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL,
    PRIMARY KEY (session_id, model, tier, speed, day)
) STRICT;

-- The usage of removed threads: Store.Remove adds a session's rows here in the same
-- transaction that deletes it (which cascades its session_usage rows away). Only ever
-- added to, once per removed session.
CREATE TABLE usage_retired (
    model TEXT NOT NULL, tier TEXT NOT NULL, speed TEXT NOT NULL, day TEXT NOT NULL,
    requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,
    PRIMARY KEY (model, tier, speed, day)
) STRICT;
