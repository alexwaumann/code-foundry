-- GitHub store cache (internal/store/gh). Every row is disposable last-known state: it
-- lets reads answer instantly on daemon start and tolerate being offline. payload is
-- JSON of the store's domain types wrapped in {"v": <cacheVersion>, "data": ...}; rows
-- with another version are ignored and overwritten by the next fetch. Times are unix
-- milliseconds.

CREATE TABLE IF NOT EXISTS gh_viewer (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL
);

-- One pull request with its checks (fetched on demand).
CREATE TABLE IF NOT EXISTS gh_pull_request_details (
  slug       TEXT    NOT NULL,
  number     INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (slug, number)
);

-- Checks for a ref (fetched on demand).
CREATE TABLE IF NOT EXISTS gh_ref_checks (
  slug       TEXT    NOT NULL,
  ref        TEXT    NOT NULL,
  fetched_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL,
  PRIMARY KEY (slug, ref)
);

CREATE INDEX IF NOT EXISTS gh_pull_request_details_fetched_at ON gh_pull_request_details (fetched_at);
CREATE INDEX IF NOT EXISTS gh_ref_checks_fetched_at ON gh_ref_checks (fetched_at);

-- The polled state (activity_cache.go): the viewer dashboards ("dashboard"), global
-- monthly stats ("stats"), per-repository stats ("repo_stats:<slug>") and default-branch
-- CI ("default_branch:<slug>"), per-branch pull requests ("branch:<slug>:<head>"), and
-- the last successful poll ("poll").
CREATE TABLE IF NOT EXISTS gh_activity (
  key        TEXT    PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  payload    TEXT    NOT NULL
);
