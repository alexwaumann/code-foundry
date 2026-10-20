-- Ember's task board (internal/store/ember, docs/notes/ember-2-store.md): one row per
-- unit of work of the resident agent. id is "t-" and 8 hex digits; state is todo,
-- doing, blocked, done or cancelled; parent_id names the task it is part of (one level
-- only, '' for none); thread_id the worker thread that owns it ('' for none; the row
-- stays when that thread is archived or removed). outcome is what came of it or why it
-- stopped. position orders the board. Times are unix milliseconds; done_at is NULL
-- unless done.
CREATE TABLE ember_tasks (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL,
    parent_id  TEXT NOT NULL DEFAULT '',
    thread_id  TEXT NOT NULL DEFAULT '',
    outcome    TEXT NOT NULL DEFAULT '',
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    done_at    INTEGER
) STRICT;
