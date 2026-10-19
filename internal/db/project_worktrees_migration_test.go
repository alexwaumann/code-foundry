package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0035 records the worktrees the app made: every thread row that made its
// worktree (archived ones too), once per path with the earliest thread's time; a thread
// in place or in a worktree it did not make adds nothing.
func TestProjectWorktreesMigrationBackfill(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 35 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, project_id, worktree_path, created_at, state, created_worktree, archived_at) VALUES
		('s1', 'p1', '/wt/p1/cf/a', 200, 4, 1, 0),
		('s2', 'p1', '/wt/p1/cf/a', 100, 4, 1, 0),     -- a fork of s1's worktree, older here
		('s3', 'p1', '/wt/p1/cf/b', 300, 4, 1, 999),   -- archived
		('s4', 'p1', '/p1', 400, 4, 0, 0),             -- in place
		('s5', 'p1', '/wt/p1/by-hand', 500, 4, 0, 0),  -- a worktree it did not make
		('s6', '', '/home', 600, 4, 1, 0)              -- no project`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `SELECT path, project_id, head, created_at FROM project_worktrees ORDER BY path`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	type row struct {
		path, project, head string
		at                  int64
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.path, &r.project, &r.head, &r.at); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	want := []row{{"/wt/p1/cf/a", "p1", "", 100}, {"/wt/p1/cf/b", "p1", "", 300}}
	if len(got) != len(want) {
		t.Fatalf("rows = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("row %d = %v, want %v", i, got[i], want[i])
		}
	}
}
