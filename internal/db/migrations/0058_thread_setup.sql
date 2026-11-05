-- A thread's setup (internal/store/thread/setup.go, docs/notes/instant-threads-1-daemon.md):
-- the steps Create went through, what it made so far and, until it ended, what it needs to
-- run again, as JSON. Empty on rows from before it, forks and resident threads.
ALTER TABLE threads ADD COLUMN setup TEXT NOT NULL DEFAULT '';
