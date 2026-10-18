-- Plugin flags on threads and plugins' session environment contributions
-- (docs/notes/plugins-3-events-flags-env.md).
--
-- thread_flags (internal/store/thread/flags.go): at most one flag per (thread, plugin),
-- an overlay on the thread's status. source is the plugin's name, source_name its display
-- name when the flag was set; level 1 attention, 2 error; reason one line of at most 80
-- characters; until_seen clears it when the thread is opened; set_at unix milliseconds.
-- Gone with the thread, when archived, and when the plugin is disabled or removed.
CREATE TABLE thread_flags (
    thread_id   TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    source      TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    level       INTEGER NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    until_seen  INTEGER NOT NULL DEFAULT 0,
    set_at      INTEGER NOT NULL,
    PRIMARY KEY (thread_id, source)
) STRICT;

-- The last session/setEnvironment contribution of each plugin
-- (internal/store/plugin/environment.go), as the plugin pushed it (pluginsdk.Environment
-- JSON), so a daemon restart spawns threads with it before the plugin pushes again.
-- Dropped when the plugin is disabled or removed.
CREATE TABLE plugin_environments (
    plugin     TEXT PRIMARY KEY,
    env_json   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
