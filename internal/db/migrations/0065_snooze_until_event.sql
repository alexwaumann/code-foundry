-- Snoozing a thread until an event (internal/store/thread/snooze_event.go,
-- docs/notes/snooze-until-event.md). New tables only, so the way back
-- (wayback/0061_layout.sql) can drop them.
--
-- thread_snooze_events: a thread's snooze until an event. While it waits, subscription_id
-- names the thread_subscriptions row the daemon owns for it (subscriber: the thread) and
-- title and plugin are what the GUI shows; once the event ended the snooze,
-- subscription_id is '' and ended_by says why ("#812 was merged"). Any later snooze
-- replaces the row; it goes with its thread.
CREATE TABLE thread_snooze_events (
    thread_id       TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL DEFAULT '',
    title           TEXT NOT NULL DEFAULT '',
    plugin          TEXT NOT NULL DEFAULT '',
    since           INTEGER NOT NULL DEFAULT 0, -- unix ms
    ended_by        TEXT NOT NULL DEFAULT ''
);
-- The plugin wake sources the user snoozed on, newest first by used_at: the Until event
-- menu offers the latest three.
CREATE TABLE snooze_recent_events (
    target  TEXT PRIMARY KEY, -- "<plugin>/<source>"
    used_at INTEGER NOT NULL  -- unix ms
);
