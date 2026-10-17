package db

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Migration 0026 renames repos to projects and every repo_id column to project_id: a
// database written before it keeps its rows, actions still cascade from projects, the
// actions index follows, and a build that predates it refuses the upgraded file.
func TestProjectsMigrationKeepsRowsAndCascades(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 26 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO repos (id, path, name, registered_at) VALUES ('p1', '/p1', 'one', 1), ('p2', '/p2', 'two', 2)`,
		`INSERT INTO threads (id, repo_id, worktree_path, created_at, state) VALUES ('t1', 'p1', '/p1', 1, 4)`,
		`INSERT INTO workspaces (id, name, branch, created_at) VALUES ('w1', 'ws', 'b', 1)`,
		`INSERT INTO workspace_members (workspace_id, repo_id, worktree_path, added_at) VALUES ('w1', 'p1', '/wt/p1', 1)`,
		`INSERT INTO actions (id, repo_id, name, command, position, created_at, updated_at)
			VALUES ('a1', 'p1', 'Test', 'go test', 0, 1, 1), ('a2', 'p2', 'Test', 'go test', 0, 1, 1)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}

	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	count := func(q string) int {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, q).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	for _, tt := range []struct {
		q    string
		want int
	}{
		{`SELECT count(*) FROM projects`, 2},
		{`SELECT count(*) FROM projects WHERE id = 'p1' AND path = '/p1' AND name = 'one'`, 1},
		{`SELECT count(*) FROM threads WHERE project_id = 'p1'`, 1},
		{`SELECT count(*) FROM workspace_members WHERE project_id = 'p1'`, 1},
		{`SELECT count(*) FROM actions WHERE project_id = 'p1'`, 1},
		{`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'actions_project_name'`, 1},
		{`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'sqlite_autoindex_projects_1'`, 1},
		{`SELECT count(*) FROM sqlite_master WHERE name LIKE 'repo%' OR name LIKE '%\_repo%' ESCAPE '\'`, 0},
		{`SELECT count(*) FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'repo_id'`, 0},
	} {
		if got := count(tt.q); got != tt.want {
			t.Errorf("%s = %d, want %d", tt.q, got, tt.want)
		}
	}

	// The recreated index still makes a name unique within its project, ignoring case,
	// and the path column is still unique.
	if _, err := db.ExecContext(ctx, `INSERT INTO actions (id, project_id, name, command, position, created_at, updated_at)
		VALUES ('a3', 'p1', 'TEST', 'x', 1, 1, 1)`); err == nil {
		t.Error("a second action named TEST in p1 was accepted")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO projects (id, path, name, registered_at) VALUES ('p3', '/p1', 'dup', 3)`); err == nil {
		t.Error("a second project at /p1 was accepted")
	}

	// The foreign key followed the rename: removing a project cascades to its actions.
	var fk string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE name = 'actions'`).Scan(&fk); err != nil || !strings.Contains(fk, `REFERENCES "projects"`) && !strings.Contains(fk, "REFERENCES projects") {
		t.Errorf("actions sql = %q, %v", fk, err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM projects WHERE id = 'p1'`); err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT count(*) FROM actions WHERE project_id = 'p1'`); n != 0 {
		t.Errorf("p1 actions after cascade = %d", n)
	}
	if n := count(`SELECT count(*) FROM actions WHERE project_id = 'p2'`); n != 1 {
		t.Errorf("p2 actions = %d", n)
	}
	// workspace_members.project_id never referenced projects (the workspace store drops
	// members itself); its cascade from workspaces is untouched.
	if _, err := db.ExecContext(ctx, `DELETE FROM workspaces WHERE id = 'w1'`); err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT count(*) FROM workspace_members`); n != 0 {
		t.Errorf("members after the workspace went = %d", n)
	}

	// A build that predates 0026 refuses the upgraded file instead of querying repos.
	if err := Migrate(ctx, db, before); !errors.Is(err, ErrNewerSchema) {
		t.Errorf("migrate with 0001-0025 = %v, want ErrNewerSchema", err)
	}
}
