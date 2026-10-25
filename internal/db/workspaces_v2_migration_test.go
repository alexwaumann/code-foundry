package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0048 drops the workspace branch and the member worktree paths, adds the root
// and the default primary (the first member added, else the workspace's folder).
func TestWorkspacesV2Migration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 48 {
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
		`INSERT INTO workspaces (id, name, branch, created_at) VALUES ('w-2', 'empty', 'cf/empty', 1)`,
		`INSERT INTO workspace_members (workspace_id, project_id, worktree_path, added_at) VALUES ('w-1', 'web', '/wt/web', 2)`,
		`INSERT INTO workspace_members (workspace_id, project_id, worktree_path, added_at) VALUES ('w-1', 'api', '/wt/api', 1)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{"w-1": "api", "w-2": "workspace"} {
		var root, primary string
		if err := db.QueryRowContext(ctx, `SELECT root_path, default_primary FROM workspaces WHERE id = ?`, id).Scan(&root, &primary); err != nil {
			t.Fatal(err)
		}
		if root != "" || primary != want {
			t.Errorf("%s: root %q, default primary %q; want none and %q", id, root, primary, want)
		}
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM workspace_members WHERE workspace_id = 'w-1'`).Scan(&n); err != nil || n != 2 {
		t.Errorf("members %d, %v", n, err)
	}
	if _, err := db.ExecContext(ctx, `SELECT worktree_path FROM workspace_members`); err == nil {
		t.Error("worktree_path still there")
	}
	if _, err := db.ExecContext(ctx, `SELECT branch FROM workspaces`); err == nil {
		t.Error("branch still there")
	}
}
