-- Plugin-owned threads (docs/notes/plugins-6-thread-terminal.md).
--
-- owner: who owns a thread the user does not, "plugin:<name>" for a plugin's
-- (thread/create). Owned threads are hidden from the user's lists. Set once at create.
-- spawn_env (a JSON array of "KEY=VALUE") and spawn_add_dirs (a JSON array of paths):
-- what its creator gave the thread, added to every spawn of it after the plugins'
-- session environments. '[]' for every other thread.
ALTER TABLE threads ADD COLUMN owner TEXT NOT NULL DEFAULT '';
ALTER TABLE threads ADD COLUMN spawn_env TEXT NOT NULL DEFAULT '[]';
ALTER TABLE threads ADD COLUMN spawn_add_dirs TEXT NOT NULL DEFAULT '[]';
