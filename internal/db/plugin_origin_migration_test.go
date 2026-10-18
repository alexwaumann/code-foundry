package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0033 adds plugins.origin: a dev link's folder, else the install record's
// source (a GitHub repository in lower case), else '' (a package put in by hand).
func TestPluginOriginMigrationBackfill(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 33 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO plugins (name, dev_path, updated_at) VALUES ('dev', '/Users/a/src/dev', 1), ('reg', '', 1), ('gh', '', 1), ('hand', '', 1)`,
		`INSERT INTO plugin_installs (name, kind, source, version, installed_at) VALUES
			('reg', 'registry', 'https://example.com/index.json', '1.0.0', 1),
			('gh', 'github', 'Owner/Repo', '1.0.0', 1),
			('dev', 'path', '/Users/a/src/dev', '1.0.0', 1)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"dev": "path:/Users/a/src/dev", "reg": "registry:https://example.com/index.json", "gh": "github:owner/repo", "hand": ""}
	for name, w := range want {
		var got string
		if err := db.QueryRowContext(ctx, `SELECT origin FROM plugins WHERE name = ?`, name).Scan(&got); err != nil || got != w {
			t.Errorf("%s: origin %q, %v; want %q", name, got, err, w)
		}
	}
}
