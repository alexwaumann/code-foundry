-- Who owns each HTML page, and the user's answer for pages no thread owns
-- (internal/store/page, docs/notes/page-ownership-daemon.md). Both keyed by the page file's
-- absolute path with its symlinks resolved. Additive: empty tables, nothing existing is read
-- or rewritten; a page with no row is no thread's and not asked about.
--
-- page_owners: the thread that last showed the page (view.inline, view.open.page) or wrote
-- it (Claude's Write, Edit or MultiEdit); latest wins. A removed thread's rows go with its
-- threads row, so a page never points at a thread that is gone.
CREATE TABLE page_owners (
    path       TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    how        TEXT NOT NULL,              -- 'shown' or 'written'
    updated_at INTEGER NOT NULL            -- unix ms
);
CREATE INDEX page_owners_thread ON page_owners (thread_id);

-- page_consent: the user's answer for a page no thread owns: 1 allowed, 0 refused. No row:
-- not asked. Not tied to the file's content: an edit does not ask again.
CREATE TABLE page_consent (
    path       TEXT PRIMARY KEY,
    allowed    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
