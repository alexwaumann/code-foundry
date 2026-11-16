-- Notifications (internal/store/notification, docs/notes/notifications-1-store.md): what
-- plugins and the notification.post command put in the bell. One row per source and key:
-- a re-post of the key updates the row, and a dismissed row is kept so a re-post with the
-- same content stays dismissed. Rows that are no longer active (dismissed, withdrawn,
-- resolved) are pruned 30 days after their last change. Times are unix ms, 0 for none.
CREATE TABLE notifications (
    id             TEXT PRIMARY KEY,            -- "n-" + 12 hex digits
    source         TEXT NOT NULL,               -- a plugin's name, or "command"
    key            TEXT NOT NULL,               -- the source's key, or one derived from the content
    level          TEXT NOT NULL,               -- info, warning or error
    time_sensitive INTEGER NOT NULL DEFAULT 0,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    thread_id      TEXT NOT NULL DEFAULT '',    -- no foreign key: the thread store owns threads
    actions        TEXT NOT NULL DEFAULT '[]',  -- JSON: notification.Action, in order
    show_at        INTEGER NOT NULL DEFAULT 0,  -- when the source asked it to be shown
    state          TEXT NOT NULL,               -- active, dismissed, withdrawn or resolved
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    arrived_at     INTEGER NOT NULL DEFAULT 0,  -- when it was last shown; 0 while it waits for show_at
    snoozed_until  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source, key)
) STRICT;
