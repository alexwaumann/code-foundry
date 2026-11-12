package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0061 adds the layout tables, empty, to a database that already holds threads
// and projects; nothing else changes and the tables take the rows the layout store writes.
func TestLayoutMigrationOnExistingDatabase(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 61 {
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
		`INSERT INTO threads (id, project_id, worktree_path, created_at, state) VALUES ('s-1', 'web', '/web', 1, 4), ('s-2', 'web', '/web', 2, 4)`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	// Running it again is a no-op.
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}

	for _, table := range []string{"layout_spaces", "layout_threads", "layout_meta"} {
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM `+table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d rows, %v; want an empty table", table, n, err)
		}
	}
	var threads int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM threads`).Scan(&threads); err != nil || threads != 2 {
		t.Errorf("threads: %d, %v; want both rows kept", threads, err)
	}
	for _, q := range []string{
		`INSERT INTO layout_spaces (id, name, position, doc, updated_at) VALUES ('sp-a', 'Main', 0, '{"v":1,"root":null}', 1)`,
		`INSERT INTO layout_threads (thread_id, space_id, updated_at) VALUES ('s-1', 'sp-a', 1)`,
		`INSERT INTO layout_meta (key, value) VALUES ('rev', '1')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	var doc string
	if err := db.QueryRowContext(ctx, `SELECT doc FROM layout_threads WHERE thread_id = 's-1'`).Scan(&doc); err != nil || doc != "{}" {
		t.Errorf("layout_threads.doc default: %q, %v; want {}", doc, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO layout_spaces (id, name, position, doc, updated_at) VALUES ('sp-a', 'Again', 1, '{}', 1)`); err == nil {
		t.Error("a second row with one space id was accepted")
	}
}
