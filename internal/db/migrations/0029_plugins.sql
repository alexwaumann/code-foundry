-- Plugins (internal/store/plugin, docs/notes/plugins-1-core.md): one row per plugin the
-- user enabled, consented to or linked with `plugin dev`. A plugin found on disk without
-- a row is disabled. enabled is the user's choice; granted_json the permissions they
-- consented to (pluginsdk.Permissions, normalized JSON; '' = never consented) and
-- consented_at when (unix milliseconds); dev_path the folder `plugin dev` linked into
-- plugins/. Rows outlive the package directory, so consent survives a reinstall.
CREATE TABLE plugins (
    name         TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    granted_json TEXT NOT NULL DEFAULT '',
    consented_at INTEGER NOT NULL DEFAULT 0,
    dev_path     TEXT NOT NULL DEFAULT '',
    updated_at   INTEGER NOT NULL
) STRICT;

-- The names, never the values, of each plugin's secrets (the values are in the macOS
-- Keychain, service code-foundry-plugin, account <plugin>/<key>), and when each was set.
CREATE TABLE plugin_secrets (
    plugin     TEXT NOT NULL,
    key        TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin, key)
) STRICT;
