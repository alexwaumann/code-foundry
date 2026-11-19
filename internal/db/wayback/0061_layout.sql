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
--
-- Migrations after 0061 are undone too, since the older build refuses any it does not know:
-- 0062 (projects' include patterns for file search) loses each project's own patterns, and a
-- later update makes the empty table again (docs/notes/file-search-1-includes.md); 0063 (the
-- bell's notifications) loses every notification and the dismissed keys, so a source's
-- re-post shows again (docs/notes/notifications-1-store.md); 0064 (whether each notification
-- was seen) goes with that table; 0065 (snoozes until an event)
-- loses what event snoozed threads wait on, so they stay saved for later
-- (docs/notes/snooze-until-event.md); 0066 (auto-tidy's state per thread) loses its marks, so
-- threads it saved read as saved by the user (docs/notes/auto-tidy.md); 0067 (pages' owners
-- and the user's answers for pages) loses them, so a page outside a thread's pages directory
-- is asked about again (docs/notes/page-ownership-daemon.md); 0068 (a page's many owners and
-- what is left to carry into its storage) goes with them. The pages' storage on disk stays
-- (page-file-storage/), and the older build reads a thread's page's storage from the thread's
-- own file again (page-storage/), which 0068 never rewrote (docs/notes/page-storage-per-file.md).
BEGIN;
DROP TABLE IF EXISTS layout_spaces;
DROP TABLE IF EXISTS layout_threads;
DROP TABLE IF EXISTS layout_meta;
DROP TABLE IF EXISTS project_include_ignored;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS thread_snooze_events;
DROP TABLE IF EXISTS snooze_recent_events;
DROP TABLE IF EXISTS thread_tidy;
DROP TABLE IF EXISTS page_owners;
DROP TABLE IF EXISTS page_consent;
DROP TABLE IF EXISTS page_storage_carry;
DELETE FROM schema_migrations WHERE version IN (61, 62, 63, 64, 65, 66, 67, 68);
COMMIT;
