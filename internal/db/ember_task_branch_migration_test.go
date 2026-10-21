package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0043 adds ember_tasks.branch: a task written before it has an empty branch and
// the column takes a branch name.
func TestEmberTaskBranchMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 43 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO ember_tasks (id, title, state, position, created_at, updated_at)
		VALUES ('t-00000001', 'Old', 'done', 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var branch string
	if err := db.QueryRowContext(ctx, `SELECT branch FROM ember_tasks WHERE id = 't-00000001'`).Scan(&branch); err != nil || branch != "" {
		t.Fatalf("branch = %q, %v; want ''", branch, err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE ember_tasks SET branch = 'cf/readme' WHERE id = 't-00000001'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT branch FROM ember_tasks WHERE id = 't-00000001'`).Scan(&branch); err != nil || branch != "cf/readme" {
		t.Fatalf("branch = %q, %v", branch, err)
	}
}
