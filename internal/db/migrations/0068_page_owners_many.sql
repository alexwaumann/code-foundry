-- Every thread that showed or wrote a page owns it, not only the latest, and a page's
-- cf.storage is its file's, not its owner's (internal/store/page,
-- docs/notes/page-storage-per-file.md).
--
-- page_owners gets one row per (page, thread): each thread that showed (view.inline,
-- view.open.page) or wrote (Claude's Write, Edit, MultiEdit) the file keeps its claim, and
-- removing a thread removes only its rows. first_at is when the thread first showed or wrote
-- the page (the first owner is the page's stable default), updated_at the latest. Every
-- existing row is kept, as that thread's claim, first shown at its updated_at.
CREATE TABLE page_owners_v2 (
    path       TEXT NOT NULL,
    thread_id  TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    how        TEXT NOT NULL,              -- 'shown' or 'written': the last the thread did
    first_at   INTEGER NOT NULL,           -- unix ms
    updated_at INTEGER NOT NULL,           -- unix ms
    PRIMARY KEY (path, thread_id)
);
INSERT INTO page_owners_v2 (path, thread_id, how, first_at, updated_at)
    SELECT path, thread_id, how, updated_at, updated_at FROM page_owners;
DROP TABLE page_owners;
ALTER TABLE page_owners_v2 RENAME TO page_owners;
CREATE INDEX page_owners_thread ON page_owners (thread_id);

-- page_storage_carry: what the daemon still has to carry from each thread's own page storage
-- (<home>/page-storage/<thread id>/storage.json, one blob shared by all the thread's pages)
-- into the storage of each page file that thread's pages may have written it from. The
-- daemon carries each row at its next start, before it serves anything, and deletes it then;
-- a row left by a crash is carried again, which gives the same result. The thread's own
-- storage is read, never rewritten or removed by this.
--
-- path is a page the thread owns (every row of page_owners), a page it showed in its
-- conversation before owners were kept (an html item; record = 1: the daemon makes the
-- thread an owner of it first, resolving the path as it resolves any page), or '' for every
-- page in the thread's pages directory.
CREATE TABLE page_storage_carry (
    path      TEXT NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    record    INTEGER NOT NULL,
    at        INTEGER NOT NULL,            -- unix ms: when the thread showed the page
    PRIMARY KEY (path, thread_id)
);
INSERT INTO page_storage_carry (path, thread_id, record, at)
    SELECT path, thread_id, 0, updated_at FROM page_owners;
INSERT OR IGNORE INTO page_storage_carry (path, thread_id, record, at)
    SELECT p, thread_id, 1, at FROM (
        SELECT CASE
                 WHEN substr(json_extract(data, '$.html.path'), 1, 1) = '/'
                   OR coalesce(json_extract(data, '$.html.base_dir'), '') = ''
                 THEN json_extract(data, '$.html.path')
                 ELSE json_extract(data, '$.html.base_dir') || '/' || json_extract(data, '$.html.path')
               END AS p,
               thread_id, max(created_at) AS at
        FROM thread_items
        WHERE kind = 'html' AND json_valid(data)
        GROUP BY 1, 2
    ) WHERE coalesce(p, '') <> '';
INSERT OR IGNORE INTO page_storage_carry (path, thread_id, record, at)
    SELECT '', id, 0, 0 FROM threads;
