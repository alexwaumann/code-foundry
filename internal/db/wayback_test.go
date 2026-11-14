package db

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// The way back from migration 0061: a database the shell migrated and used is refused by a
// build from before it; after LayoutWayBack that build opens it, with every thread and project
// kept and only the layout gone. A later build migrates it again to empty layout tables, so the
// first-load import runs once more.
func TestLayoutWayBack(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	old := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 61 {
			old[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO projects (id, path, name, registered_at) VALUES ('web', '/web', 'web', 0)`,
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('s-1', 'web', '/web', 1, 4)`,
		`INSERT INTO layout_spaces (id, name, position, doc, updated_at) VALUES ('sp-a', 'Main', 0, '{"v":1,"root":null}', 1)`,
		`INSERT INTO layout_threads (thread_id, space_id, updated_at) VALUES ('s-1', 'sp-a', 1)`,
		`INSERT INTO layout_meta (key, value) VALUES ('legacy_import', 'done:1')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	// A build from before the shell refuses it.
	if err := Migrate(ctx, db, old); !errors.Is(err, ErrNewerSchema) {
		t.Fatalf("an old build: %v, want ErrNewerSchema", err)
	}

	if _, err := db.ExecContext(ctx, LayoutWayBack); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, old); err != nil {
		t.Fatalf("an old build after the way back: %v", err)
	}
	for _, table := range []string{"layout_spaces", "layout_threads", "layout_meta"} {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d, %v; want it gone", table, n, err)
		}
	}
	var threads, projects int
	if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM threads), (SELECT count(*) FROM projects)`).Scan(&threads, &projects); err != nil || threads != 1 || projects != 1 {
		t.Errorf("threads %d, projects %d, %v; want both kept", threads, projects, err)
	}
	// Running it twice is harmless.
	if _, err := db.ExecContext(ctx, LayoutWayBack); err != nil {
		t.Fatal(err)
	}

	// Updating again: 0061 runs once more, to empty tables (the import has not run).
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var mark int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM layout_meta`).Scan(&mark); err != nil || mark != 0 {
		t.Errorf("layout_meta: %d rows, %v; want empty", mark, err)
	}
	_ = db.Close()
}
