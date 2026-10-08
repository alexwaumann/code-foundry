-- Phase 3a GitHub activity cache (internal/store/gh/activity_cache.go): the viewer
-- dashboards ("dashboard"), global monthly stats ("stats"), per-repository stats
-- ("repo_stats:<slug>") and default-branch CI ("default_branch:<slug>"), and
-- per-branch pull requests ("branch:<slug>:<head>"). Same payload envelope and time
-- unit as 0002_gh.sql. Mirrored in internal/store/gh/schema.sql for the store's tests.

CREATE TABLE IF NOT EXISTS gh_activity (
  key        TEXT    PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL
);
