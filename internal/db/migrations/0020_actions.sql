-- Actions (internal/store/action): per-project commands a user defines and runs from
-- the GUI or `code-foundry action run` (a thread's agent too). Times are unix
-- milliseconds. icon is one of play, test, lint, configure, build, debug (checked by
-- the store). in_terminal: runs open as a terminal in the bottom panel, else they run
-- in the background with captured output. on_worktree_create: runs (in the background)
-- when a new thread creates its worktree. position orders a project's actions.
-- Unregistering the project deletes its actions.
CREATE TABLE actions (
    id                 TEXT PRIMARY KEY,           -- "a-" + 12 hex digits
    repo_id            TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    command            TEXT NOT NULL,
    icon               TEXT NOT NULL DEFAULT 'play',
    in_terminal        INTEGER NOT NULL DEFAULT 1,
    on_worktree_create INTEGER NOT NULL DEFAULT 0,
    position           INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
) STRICT;

-- A name is unique within its project, ignoring (ASCII) case.
CREATE UNIQUE INDEX actions_repo_name ON actions (repo_id, name COLLATE NOCASE);
