-- Every action run (internal/store/action), recorded when it starts: which action, which
-- thread it belongs to ('' for a worktree's run), the runner ('terminal' or
-- 'background'), what started it ('user' or 'worktree_create') and when (unix
-- milliseconds). The runs themselves (state, output) stay in memory; this is what the
-- thread info card's action row and `action list`'s last-run column read across daemon
-- restarts. Forgetting an action forgets its records; the store keeps the newest 500 per
-- project.
CREATE TABLE action_runs (
    id         TEXT PRIMARY KEY,           -- the run id, "r-" + 12 hex digits
    action_id  TEXT NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    thread_id  TEXT NOT NULL DEFAULT '',
    runner     TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    started_at INTEGER NOT NULL
) STRICT;

CREATE INDEX action_runs_project ON action_runs (project_id, started_at);
