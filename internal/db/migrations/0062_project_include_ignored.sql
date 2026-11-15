-- Git-ignored files a project's file search lists too (internal/store/project,
-- docs/notes/file-search-1-includes.md): the project's own .gitignore-style patterns, added
-- to the files.include_ignored setting's. One row per project that has any: a JSON array of
-- strings in the user's order (fsx.CleanIncludePatterns' form). Removing the project
-- removes its row.
CREATE TABLE project_include_ignored (
    project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
    patterns   TEXT NOT NULL
) STRICT;
