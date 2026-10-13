-- Context totals of rendered threads (internal/store/session/context.go): the context
-- size after the last turn (the last top-level API response's input + cache read +
-- cache write + output tokens), the model that answered it, and when that turn ended
-- (unix milliseconds, 0 when never), from which the daemon computes when the prompt
-- cache expires (docs/notes/rendered-threads-cold-cache.md). Existing rows have none.
ALTER TABLE sessions ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_model TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN last_result_at INTEGER NOT NULL DEFAULT 0;
