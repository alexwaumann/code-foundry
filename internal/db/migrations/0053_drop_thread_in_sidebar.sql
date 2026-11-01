-- The sidebar override goes (docs/notes/no-sidebar-override-2-daemon.md): a thread
-- another thread created is in the sidebar only once its creator no longer exists,
-- derived from created_by, nothing stored. The in_sidebar column of 0040 goes; a value
-- set on a row goes with it.
ALTER TABLE threads DROP COLUMN in_sidebar;
