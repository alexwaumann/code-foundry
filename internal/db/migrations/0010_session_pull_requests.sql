-- Linked pull requests (internal/store/session, docs/notes/linked-prs.md): every pull
-- request Claude linked to a thread through a "pr-link" transcript record, one row per
-- URL. Rows are only inserted, in first-seen order (rowid); linked_at is the first
-- record's time, unix milliseconds.
CREATE TABLE session_pull_requests (
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,             -- "owner/name"
    number     INTEGER NOT NULL,
    url        TEXT NOT NULL,
    linked_at  INTEGER NOT NULL,
    PRIMARY KEY (session_id, url)
) STRICT;

CREATE INDEX session_pull_requests_session ON session_pull_requests (session_id);
