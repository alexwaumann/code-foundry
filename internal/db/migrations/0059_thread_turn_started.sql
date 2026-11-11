-- When a thread's latest turn started (internal/store/thread/turn.go), in unix
-- milliseconds; 0 when it has none. A report older than it describes an earlier turn
-- (Thread.report_stale), which thread.reports and thread.get read from the row instead of
-- the thread's items.
ALTER TABLE threads ADD COLUMN turn_started_at INTEGER NOT NULL DEFAULT 0;

-- Existing threads: read from their items by the store's rule (lastTurn). Only top-level
-- user messages Claude read (not queued) and turn ends count, in the log's order (a placed
-- message sits right after the item it was read at, after any placed there before it);
-- a message starts a turn when the one before it in that order is a turn end, or there is
-- none. The latest such message is the turn's start.
UPDATE threads SET turn_started_at = s.started
FROM (
    SELECT thread_id, created_at AS started
    FROM (
        SELECT thread_id, kind, created_at,
            LAG(kind) OVER (PARTITION BY thread_id ORDER BY placed_key, placed, ordinal) AS prev,
            ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY placed_key DESC, placed DESC, ordinal DESC) AS from_end
        FROM (
            SELECT thread_id, kind, created_at, ordinal,
                COALESCE(NULLIF(json_extract(data, '$.placed_after'), 0), ordinal) AS placed_key,
                COALESCE(json_extract(data, '$.placed_after'), 0) > 0 AS placed
            FROM thread_items
            WHERE parent_tool_use_id = ''
                AND (kind = 'turn_end' OR (kind = 'user_message' AND NOT COALESCE(json_extract(data, '$.queued'), 0)))
        )
    )
    WHERE kind = 'user_message' AND (prev IS NULL OR prev = 'turn_end')
    GROUP BY thread_id
    HAVING from_end = MIN(from_end)
) AS s
WHERE s.thread_id = threads.id;
