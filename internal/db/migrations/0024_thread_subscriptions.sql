-- Wake subscriptions (internal/store/thread/subscriptions.go, docs/notes/agents-4-wake.md):
-- the subscriber thread is sent a wake message when the target meets the condition.
-- id is "sub-" + 12 hex digits. target_kind is 'thread' (target_id a thread id; no
-- foreign key: the store deletes a removed or archived target's subscriptions) or
-- 'action_run' (target_id a run id; runs live in memory, so the store deletes these at
-- startup). condition is settled, idle, attention, error or disconnected for a thread,
-- finished for a run. repeat: fires on every transition into the condition, else the row
-- goes once it fired. Times are unix milliseconds; last_fired_at 0 until it fired.
CREATE TABLE thread_subscriptions (
    id                   TEXT PRIMARY KEY,
    subscriber_thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    target_kind          TEXT NOT NULL,
    target_id            TEXT NOT NULL,
    condition            TEXT NOT NULL,
    repeat               INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    fired_count          INTEGER NOT NULL DEFAULT 0,
    last_fired_at        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX thread_subscriptions_subscriber ON thread_subscriptions (subscriber_thread_id);
