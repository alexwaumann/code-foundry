package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0049 gives every thread a checkouts column, empty ("not recorded yet"): the
// thread store fills it from the project store at its next start.
func TestThreadCheckoutsMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 49 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO threads (id, project_id, project_ids, worktree_path, created_at, state, created_worktree, branch) VALUES ('wt', 'web', '["api","web"]', '/wt/web/feat-x', 1, 4, 1, 'feat/x')`,
		`INSERT INTO threads (id, project_id, project_ids, worktree_path, created_at, state) VALUES ('none', '', '[]', '/home', 1, 4)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	tests := []struct{ id, want string }{{"wt", ""}, {"none", ""}}
	for _, tt := range tests {
		var got, branch string
		if err := db.QueryRowContext(ctx, `SELECT checkouts, branch FROM threads WHERE id = ?`, tt.id).Scan(&got, &branch); err != nil {
			t.Fatal(err)
		}
		if got != tt.want {
			t.Errorf("%s: checkouts %q, want %q", tt.id, got, tt.want)
		}
		if tt.id == "wt" && branch != "feat/x" {
			t.Errorf("%s: branch %q, want the created-for branch kept", tt.id, branch)
		}
	}
	if _, err := db.ExecContext(ctx, `UPDATE threads SET checkouts = '{"api":"/wt/api/feat-x"}' WHERE id = 'wt'`); err != nil {
		t.Fatal(err)
	}
}
