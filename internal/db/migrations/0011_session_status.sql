-- Thread status persistence (internal/store/session): the last status and reason a
-- session had, kept once it disconnects and across daemon restarts, so a thread that
-- was asking a question or waiting on a permission prompt still shows it. status
-- mirrors codefoundry.v1.SessionStatus (0 unknown, 1 busy, 2 idle, 3 needs attention,
-- 4 error); status_changed_at is unix milliseconds, 0 when never known. Existing rows
-- are unknown.
ALTER TABLE sessions ADD COLUMN status INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN status_changed_at INTEGER NOT NULL DEFAULT 0;
