-- Where installed plugin packages came from (internal/store/plugin/install.go,
-- docs/notes/plugins-7-registry.md): one row per package `plugin install` put in
-- plugins/<name>. kind is registry (source = the registry's URL), github (a release of
-- source = owner/repo) or path (a folder linked like `plugin dev`; source = the folder);
-- version and sha256 (of the tarball; '' for a link or an unverified release) as
-- installed; installed_at unix milliseconds. Gone on uninstall. A package put in plugins/
-- by hand has no row.
CREATE TABLE plugin_installs (
    name         TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    source       TEXT NOT NULL,
    version      TEXT NOT NULL,
    sha256       TEXT NOT NULL DEFAULT '',
    installed_at INTEGER NOT NULL
) STRICT;
