-- Wakes the daemon could not send while stopping (internal/store/thread/
-- subscriptions_restart.go, docs/notes/orch-restart-wakes.md): a thread subscription
-- whose target met its condition during shutdown (a child interrupted by the stop)
-- records when, unix milliseconds, and the next start delivers it. 0 for none.
ALTER TABLE thread_subscriptions ADD COLUMN suppressed_at INTEGER NOT NULL DEFAULT 0;
