-- Repos were renamed to projects (internal/store/project, docs/notes/rename-repo-to-project.md):
-- the table and the repo_id columns follow. "Repository" stays where it names the GitHub
-- repository (the gh_* tables, repo slugs). SQLite rewrites the REFERENCES in actions on
-- RENAME TO (legacy_alter_table is off) and renames the path column's autoindex with its
-- table; the actions index is recreated by hand because index names do not follow their
-- columns.
ALTER TABLE repos RENAME TO projects;

ALTER TABLE threads RENAME COLUMN repo_id TO project_id;

ALTER TABLE workspace_members RENAME COLUMN repo_id TO project_id;

ALTER TABLE actions RENAME COLUMN repo_id TO project_id;
DROP INDEX actions_repo_name;
CREATE UNIQUE INDEX actions_project_name ON actions (project_id, name COLLATE NOCASE);
