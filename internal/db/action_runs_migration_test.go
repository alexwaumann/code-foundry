package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0050 adds action_runs to a database that has actions: an upgrade in place
// keeps the actions, the new table takes records, and forgetting an action forgets them.
func TestActionRunsMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 50 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO projects (id, path, name, registered_at) VALUES ('web', '/web', 'web', 0)`,
		`INSERT INTO actions (id, project_id, name, command, position, created_at, updated_at) VALUES ('a-1', 'web', 'Build', 'make', 0, 1, 1)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(q, err)
		}
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO action_runs (id, action_id, project_id, thread_id, runner, trigger, started_at)
		VALUES ('r-1', 'a-1', 'web', 's-1', 'terminal', 'user', 5)`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM action_runs WHERE action_id = 'a-1'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("records = %d, %v", n, err)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM actions WHERE id = 'a-1'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM action_runs`).Scan(&n); err != nil || n != 0 {
		t.Errorf("records after the action went = %d, %v", n, err)
	}
}
