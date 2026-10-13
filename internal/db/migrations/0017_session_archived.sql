-- Archived threads (internal/store/session/archive.go): when the user archived the
-- thread (SessionService.Archive, session.archive), in unix milliseconds; 0 when it is
-- not archived. The GUI lists archived threads apart from the main thread list.
-- Existing rows are not archived.
ALTER TABLE sessions ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0;
