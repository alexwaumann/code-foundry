package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0051 gives every thread an empty last_heads column (nothing recorded: a
// recreate uses the created-for branch, as before), which takes what the thread store
// writes.
func TestThreadLastHeadsMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 51 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, project_id, project_ids, worktree_path, created_at, state, created_worktree, branch, checkouts)
		VALUES ('wt', 'web', '["web"]', '/wt/web/feat-x', 1, 4, 1, 'feat/x', '{"web":"/wt/web/feat-x"}')`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.QueryRowContext(ctx, `SELECT last_heads FROM threads WHERE id = 'wt'`).Scan(&got); err != nil || got != "" {
		t.Fatalf("last_heads %q, %v; want empty", got, err)
	}
	const recorded = `{"web":"feat/y"}`
	if _, err := db.ExecContext(ctx, `UPDATE threads SET last_heads = ? WHERE id = 'wt'`, recorded); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT last_heads FROM threads WHERE id = 'wt'`).Scan(&got); err != nil || got != recorded {
		t.Errorf("last_heads after a write = %q, %v; want %q", got, err, recorded)
	}
}
