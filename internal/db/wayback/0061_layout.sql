-- The way back from migration 0061 (the window shell's layout), for a build from before the
-- shell, which refuses a database that records a migration it does not know. Run it with the
-- daemon stopped:
--
--     sqlite3 ~/.code-foundry/db.sqlite < 0061_layout.sql
--
-- It removes the layout's three tables and the migration's record, and nothing else: threads,
-- projects, settings and every other table are kept. The older build then opens the database as
-- it left it. Only the layout is lost (its spaces, panes, tabs and each thread's remembered tabs);
-- the classic window's own side panels were never removed from its storage, so they come back
-- as they were. A later update runs 0061 again and imports the classic panels once more.
-- docs/notes/shell-24a-import-moves.md, item 6.
BEGIN;
DROP TABLE IF EXISTS layout_spaces;
DROP TABLE IF EXISTS layout_threads;
DROP TABLE IF EXISTS layout_meta;
DELETE FROM schema_migrations WHERE version = 61;
COMMIT;
