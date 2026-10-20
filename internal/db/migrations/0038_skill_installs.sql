-- Standalone skills Code Foundry installed from a marketplace (internal/store/skill,
-- docs/notes/skills-1-registry.md): one row per skill copied into ~/.claude/skills/<name>
-- (or moved to <home>/skills/disabled/<name> while disabled). registry is the
-- marketplace's name, path the skill's repo-relative directory in it, tier enterprise or
-- community; commit_sha and commit_at (unix milliseconds) the last commit touching path
-- when it was copied, which is what update offers compare against. setup_script is
-- relative to the skill's directory ('' for none); setup_sha256 is the script's hash when
-- setup last ran and setup_done_at when it exited 0 (NULL: never). installed_at unix
-- milliseconds. A skill directory without a row is a local skill. Plugins are Claude
-- Code's: they have no row.
CREATE TABLE skill_installs (
    name          TEXT PRIMARY KEY,
    registry      TEXT NOT NULL,
    path          TEXT NOT NULL,
    tier          TEXT NOT NULL DEFAULT '',
    commit_sha    TEXT NOT NULL DEFAULT '',
    commit_at     INTEGER NOT NULL DEFAULT 0,
    setup_script  TEXT NOT NULL DEFAULT '',
    setup_sha256  TEXT NOT NULL DEFAULT '',
    setup_done_at INTEGER,
    installed_at  INTEGER NOT NULL
) STRICT;
