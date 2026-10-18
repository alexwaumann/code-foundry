-- Plugin-owned threads (docs/notes/plugins-6-thread-terminal.md).
--
-- threads.owner: who owns a thread the user does not, "plugin:<name>" for a plugin's
-- (thread/create). Owned threads are hidden from the user's lists; set once at create.
ALTER TABLE threads ADD COLUMN owner TEXT NOT NULL DEFAULT '';

-- plugin_threads (internal/store/plugin/threads.go): the environment and --add-dir
-- directories a plugin gave its thread at thread/create, applied at every spawn of it in
-- place of the plugin's session environment. env_json is a JSON object, add_dirs_json a
-- JSON array; created_at unix milliseconds. Rows of removed threads are swept when the
-- daemon starts.
CREATE TABLE plugin_threads (
    thread_id     TEXT PRIMARY KEY,
    plugin        TEXT NOT NULL,
    env_json      TEXT NOT NULL DEFAULT '{}',
    add_dirs_json TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX plugin_threads_plugin ON plugin_threads (plugin);
