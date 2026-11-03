-- Thread search (internal/store/thread/search*.go, docs/notes/search-3-index.md): a
-- full-text index over the text of thread items that stays visible when a turn folds
-- (user messages, assistant text, questions and their answers), for thread.search.
--
-- One document per item id, not per row: a fork's log starts with a copy of its parent's
-- items under the same ids, so a forked conversation is indexed once and a query picks
-- the holder (a thread_items row with that id) itself. The text is not stored again:
-- search_fts is contentless (trigram tokens only) and snippets are cut from
-- thread_items.data. search_docs maps an FTS rowid to its item id; hash is the indexed
-- text's FNV-1a (as a signed integer), so a rewrite with the same text (a fork's copy)
-- touches nothing.
CREATE TABLE search_docs (
    id      INTEGER PRIMARY KEY,
    item_id TEXT NOT NULL UNIQUE,
    hash    INTEGER NOT NULL
) STRICT;

-- trigram: case-insensitive substrings of 3 characters and more, so identifiers, file
-- names and partial words match.
CREATE VIRTUAL TABLE search_fts USING fts5 (text, content = '', contentless_delete = 1, tokenize = 'trigram');

-- A query finds an item's holders by id; the trigger below checks for one left.
CREATE INDEX thread_items_item_id ON thread_items (item_id);

-- A document goes with its last holder: removing a thread (its items cascade) drops the
-- documents of items no other thread holds; a fork's copies keep the rest.
CREATE TRIGGER thread_items_search_gone AFTER DELETE ON thread_items
WHEN NOT EXISTS (SELECT 1 FROM thread_items WHERE item_id = OLD.item_id)
BEGIN
    DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_docs WHERE item_id = OLD.item_id);
    DELETE FROM search_docs WHERE item_id = OLD.item_id;
END;

-- The threads whose items are not indexed yet: every thread that exists now. The thread
-- store indexes them at startup in the background, one thread per transaction, and
-- deletes each row once done, so an interrupted backfill resumes. New items are indexed
-- as they are written.
CREATE TABLE search_backfill (
    thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE
) STRICT;
INSERT INTO search_backfill (thread_id) SELECT id FROM threads;
