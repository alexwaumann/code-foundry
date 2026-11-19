-- Whether the user has seen a notification (internal/store/notification,
-- docs/notes/notification-seen.md): the bell's corner badge shows while a shown one is
-- unseen. A notification is unseen when it arrives (its first post, its show_at, the end of
-- a snooze, a closed key coming back) and seen once the bell's panel showed it or the user
-- acted on it. Rows from before this migration take the default, seen, so an upgrade lights
-- no badge for notifications the user already had.
ALTER TABLE notifications ADD COLUMN seen INTEGER NOT NULL DEFAULT 1;
