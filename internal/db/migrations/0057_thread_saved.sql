-- Saved for later (internal/store/thread/snooze.go, docs/notes/save-for-later-1-daemon.md):
-- when the user put the thread away with no wake time, in unix milliseconds; 0 when it
-- is not saved. A saved thread has snoozed_until 0, so nothing reads a wake time for it.
-- Existing rows are not saved.
ALTER TABLE threads ADD COLUMN saved_at INTEGER NOT NULL DEFAULT 0;
