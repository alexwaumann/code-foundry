package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0028 adds threads.name_provisional: a row written before it keeps its name
// as a real one (not provisional), named or not.
func TestThreadNameProvisionalMigrationDefault(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 28 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, name, auto_named)
		VALUES ('named', '/w', 1, 4, 'Fix the login redirect', 1), ('unnamed', '/w', 2, 4, '', 0)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct{ id, name string }{{"named", "Fix the login redirect"}, {"unnamed", ""}} {
		var name string
		var provisional bool
		if err := db.QueryRowContext(ctx, `SELECT name, name_provisional FROM threads WHERE id = ?`, tt.id).Scan(&name, &provisional); err != nil {
			t.Fatal(err)
		}
		if name != tt.name || provisional {
			t.Errorf("%s: name %q, provisional %v; want %q, false", tt.id, name, provisional, tt.name)
		}
	}
}
