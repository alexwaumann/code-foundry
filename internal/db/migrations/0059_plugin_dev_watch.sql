-- `plugin dev --watch` (internal/store/plugin/devwatch.go, docs/notes/plugin-dev-watch.md):
-- dev_watch 1 when the daemon watches the dev folder, builds on a change and restarts the
-- plugin; dev_build the build command ('' = make build). Both kept across daemon restarts.
ALTER TABLE plugins ADD COLUMN dev_watch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE plugins ADD COLUMN dev_build TEXT NOT NULL DEFAULT '';
