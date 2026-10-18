package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0027 adds threads.branch: a row written before it has none (the thread
// store fills it in at startup while the worktree exists).
func TestThreadBranchMigrationDefault(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 27 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, created_worktree)
		VALUES ('s1', '/w', 1, 4, 1)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var branch string
	if err := db.QueryRowContext(ctx, `SELECT branch FROM threads WHERE id = 's1'`).Scan(&branch); err != nil || branch != "" {
		t.Errorf("branch %q, %v; want empty", branch, err)
	}
}
