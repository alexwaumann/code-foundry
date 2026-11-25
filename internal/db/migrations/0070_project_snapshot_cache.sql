-- Cold-start snapshot cache for the project store (internal/store/project/cache.go).
-- One row per registered project holding the last known git metadata and worktree list
-- as JSON so daemon restarts publish a populated Snapshot before git reconcile finishes.
-- Removing a project cascades and removes its cached row.
CREATE TABLE project_snapshot_cache (
    project_id    TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
) STRICT;
