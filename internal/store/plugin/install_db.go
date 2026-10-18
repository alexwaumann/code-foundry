package plugin

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Persistence for plugin_installs (migration 0031) and the purge of a plugin's rows.

// InstallKind is where an installed package came from.
type InstallKind string

// Install kinds.
const (
	// KindRegistry: a registry's entry; InstallRecord.Source is the registry's URL.
	KindRegistry InstallKind = "registry"
	// KindGitHub: a GitHub release; Source is owner/repo.
	KindGitHub InstallKind = "github"
	// KindPath: a folder linked like `plugin dev`; Source is the folder.
	KindPath InstallKind = "path"
)

// InstallRecord says where an installed package came from.
type InstallRecord struct {
	Kind    InstallKind
	Source  string
	Version string
	// SHA256 is the tarball's hash; "" for a link or a release without checksums.
	SHA256      string
	InstalledAt time.Time
}

func loadInstallRows(ctx context.Context, db *sql.DB) (map[string]InstallRecord, error) {
	rows, err := db.QueryContext(ctx, `SELECT name, kind, source, version, sha256, installed_at FROM plugin_installs`)
	if err != nil {
		return nil, fmt.Errorf("plugin: load installs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]InstallRecord{}
	for rows.Next() {
		var name, kind string
		var r InstallRecord
		var at int64
		if err := rows.Scan(&name, &kind, &r.Source, &r.Version, &r.SHA256, &at); err != nil {
			return nil, fmt.Errorf("plugin: load installs: %w", err)
		}
		r.Kind, r.InstalledAt = InstallKind(kind), time.UnixMilli(at)
		out[name] = r
	}
	return out, rows.Err()
}

func saveInstallRow(ctx context.Context, db *sql.DB, name string, r InstallRecord) error {
	if _, err := db.ExecContext(ctx, `INSERT INTO plugin_installs (name, kind, source, version, sha256, installed_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (name) DO UPDATE SET kind = excluded.kind, source = excluded.source, version = excluded.version,
			sha256 = excluded.sha256, installed_at = excluded.installed_at`,
		name, string(r.Kind), r.Source, r.Version, r.SHA256, r.InstalledAt.UnixMilli()); err != nil {
		return fmt.Errorf("plugin: record install of %s: %w", name, err)
	}
	return nil
}

func deleteInstallRow(ctx context.Context, db *sql.DB, name string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM plugin_installs WHERE name = ?`, name); err != nil {
		return fmt.Errorf("plugin: forget install of %s: %w", name, err)
	}
	return nil
}

// deletePluginRow forgets the user's choices about a plugin (enabled, consent, dev link).
func deletePluginRow(ctx context.Context, db *sql.DB, name string) error {
	if _, err := db.ExecContext(ctx, `DELETE FROM plugins WHERE name = ?`, name); err != nil {
		return fmt.Errorf("plugin: forget %s: %w", name, err)
	}
	return nil
}
