-- Auto-tidy's state per thread (threads.auto_save_after, threads.auto_archive_after;
-- docs/notes/auto-tidy.md), in milliseconds, 0 for none:
--   auto_saved_after_ms: set while the daemon's own save for later holds, how long the thread
--     had been idle by the setting then (unsnoozing it, the user saving it again, a timed
--     snooze or an archive clears it);
--   returned_at: when the thread last came back to the list from Snoozed or Archived (an
--     unsnooze, a snooze ending, an unarchive), which auto-tidy's idle clock starts no earlier
--     than.
-- A row exists only while either is set. Additive: no thread has a row until one of them
-- happens, so nothing saved before reads as saved automatically. Its own table rather than
-- columns on threads, so the way back from 0061 can drop it with IF EXISTS and stays safe to
-- run twice.
CREATE TABLE thread_tidy (
    thread_id           TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
    auto_saved_after_ms INTEGER NOT NULL DEFAULT 0,
    returned_at         INTEGER NOT NULL DEFAULT 0
);
