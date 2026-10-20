package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0040 adds threads.in_sidebar: a row written before it, created by another
// thread or not, has no override (NULL: it follows threads.show_created_threads), and
// the column takes 0 and 1.
func TestThreadInSidebarMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 40 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, created_by)
		VALUES ('mine', '/w', 1, 4, ''), ('child', '/w', 2, 4, 'mine')`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"mine", "child"} {
		var v sql.NullBool
		if err := db.QueryRowContext(ctx, `SELECT in_sidebar FROM threads WHERE id = ?`, id).Scan(&v); err != nil {
			t.Fatal(err)
		}
		if v.Valid {
			t.Errorf("%s: in_sidebar = %v, want NULL", id, v.Bool)
		}
	}
	for _, want := range []bool{true, false} {
		if _, err := db.ExecContext(ctx, `UPDATE threads SET in_sidebar = ? WHERE id = 'child'`, want); err != nil {
			t.Fatal(err)
		}
		var v sql.NullBool
		if err := db.QueryRowContext(ctx, `SELECT in_sidebar FROM threads WHERE id = 'child'`).Scan(&v); err != nil {
			t.Fatal(err)
		}
		if !v.Valid || v.Bool != want {
			t.Errorf("in_sidebar = %+v, want %v", v, want)
		}
	}
}
