package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0047 gives every thread a project set: its own project, or a v1 workspace's
// members (sorted), in worktree mode on the workspace's branch.
func TestThreadProjectIDsMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 47 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO workspaces (id, name, branch, created_at) VALUES ('w-1', 'login', 'cf/login', 1)`,
		`INSERT INTO workspace_members (workspace_id, project_id, worktree_path, added_at) VALUES ('w-1', 'web', '/wt/web/cf-login', 1)`,
		`INSERT INTO workspace_members (workspace_id, project_id, worktree_path, added_at) VALUES ('w-1', 'api', '/wt/api/cf-login', 2)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('plain', 'web', '/src/web', 1, 4)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('none', '', '/home', 1, 4)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state, workspace_id) VALUES ('ws', 'web', '/wt/web/cf-login', 1, 4, 'w-1')`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state, workspace_id, branch) VALUES ('gone', 'web', '/x', 1, 4, 'w-gone', 'b')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		id, ids, branch string
		worktree        bool
	}{
		{"plain", `["web"]`, "", false},
		{"none", `[]`, "", false},
		{"ws", `["api","web"]`, "cf/login", true},
		{"gone", `["web"]`, "b", false},
	}
	for _, tt := range tests {
		var ids, branch string
		var wt bool
		if err := db.QueryRowContext(ctx, `SELECT project_ids, branch, created_worktree FROM threads WHERE id = ?`, tt.id).Scan(&ids, &branch, &wt); err != nil {
			t.Fatal(err)
		}
		if ids != tt.ids || branch != tt.branch || wt != tt.worktree {
			t.Errorf("%s: project_ids %s, branch %q, created_worktree %v; want %s, %q, %v", tt.id, ids, branch, wt, tt.ids, tt.branch, tt.worktree)
		}
	}
}
