-- Cached pull request unified diffs (internal/store/gh/pr_files.go). Bounded to the most
-- recently fetched entries so diffs for uncloned or fork PRs survive daemon restarts
-- without hitting GitHub REST while head_sha and base_sha remain unchanged. Mirrored in
-- internal/store/gh/schema.sql for the store's tests.

CREATE TABLE IF NOT EXISTS gh_pr_diffs (
  repo_slug  TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  head_sha   TEXT    NOT NULL,
  base_sha   TEXT    NOT NULL,
  diff       TEXT    NOT NULL,
  truncated  INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (repo_slug, number)
);

CREATE INDEX IF NOT EXISTS gh_pr_diffs_fetched_at ON gh_pr_diffs (fetched_at);
