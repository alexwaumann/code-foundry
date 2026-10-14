-- Snoozed threads (internal/store/session/snooze.go): when a snoozed thread wakes
-- (SessionService.Snooze, session.snooze), in unix milliseconds; 0 when it is not
-- snoozed. The daemon clears it when the time comes and marks the thread as needing
-- attention ("snooze ended"). Existing rows are not snoozed.
ALTER TABLE sessions ADD COLUMN snoozed_until INTEGER NOT NULL DEFAULT 0;
