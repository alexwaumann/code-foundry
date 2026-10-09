-- The GitHub store no longer polls every open pull request of tracked repositories
-- (docs/notes/gh-viewer-polling.md): the per-repository list cache is gone. Its rows
-- were disposable, so nothing is carried over.
DROP TABLE IF EXISTS gh_pull_requests;
