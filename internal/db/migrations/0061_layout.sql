-- The window shell's layout (internal/store/layout, docs/notes/shell-3-layout-store.md).
-- Empty tables only: at open the store makes a space named "Main" when there is none, and a
-- thread without a layout_threads row lives in the default space, so every existing thread
-- is in that one space with no data migration. Only the daemon reads these rows; each doc is
-- versioned JSON (internal/layout/decode.go) and is repaired, not refused, when it is wrong.
CREATE TABLE layout_spaces (
    id         TEXT PRIMARY KEY,           -- "sp-" + 8 base32 characters
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,           -- the order of the space tabs
    doc        TEXT NOT NULL,              -- layout.SpaceDoc: the pane tree, focus, MRU
    updated_at INTEGER NOT NULL            -- unix ms
);
CREATE TABLE layout_threads (
    thread_id  TEXT PRIMARY KEY,           -- no foreign key: the thread store owns threads
    space_id   TEXT NOT NULL,
    doc        TEXT NOT NULL DEFAULT '{}', -- layout.ThreadDoc: quick terminal, remembered set
    updated_at INTEGER NOT NULL
);
-- Keys: rev (the last commit), current_space, default_space.
CREATE TABLE layout_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
