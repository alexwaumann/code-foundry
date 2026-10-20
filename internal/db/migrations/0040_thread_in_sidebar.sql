-- Hidden child threads (internal/store/thread/sidebar.go,
-- docs/notes/hidden-children-1-daemon.md): in_sidebar shows (1) or hides (0) a thread
-- another thread created in the sidebar whatever the threads.show_created_threads
-- setting says; NULL follows the setting, and is the value of every existing row (the
-- user's own threads are always shown).
ALTER TABLE threads ADD COLUMN in_sidebar INTEGER;
