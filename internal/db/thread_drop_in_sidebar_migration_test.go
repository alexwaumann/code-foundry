package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0053 drops threads.in_sidebar (added by 0040): rows written with the
// override shown, hidden or unset keep everything else, and the column is gone.
func TestDropThreadInSidebarMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 53 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, created_by, in_sidebar)
		VALUES ('mine', '/w', 1, 4, '', NULL), ('shown', '/w', 2, 4, 'mine', 1), ('hidden', '/w', 3, 4, 'mine', 0)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info('threads') WHERE name = 'in_sidebar'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("threads.in_sidebar still exists after the migration")
	}
	tests := []struct{ id, createdBy string }{{"mine", ""}, {"shown", "mine"}, {"hidden", "mine"}}
	for _, tt := range tests {
		var createdBy string
		if err := db.QueryRowContext(ctx, `SELECT created_by FROM threads WHERE id = ?`, tt.id).Scan(&createdBy); err != nil {
			t.Fatalf("%s: %v", tt.id, err)
		}
		if createdBy != tt.createdBy {
			t.Errorf("%s: created_by = %q, want %q", tt.id, createdBy, tt.createdBy)
		}
	}
}
