package db

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"
)

// Migration 0068 keeps every page_owners row as that thread's claim (first_at = its
// updated_at), lets a second thread own the same page, and lists what the daemon carries
// into pages' storage: every owner row, every page a thread's conversation showed (resolved
// against its base directory), and each thread's pages directory.
func TestPageOwnersManyMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 68 {
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
		`INSERT INTO page_owners (path, thread_id, how, updated_at) VALUES ('/h/a.html', 's-1', 'written', 50)`,
		// s-2 showed a.html before owners were kept, twice; s-1 showed b.html relative to its cwd.
		`INSERT INTO thread_items (thread_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data) VALUES
			('s-2', 1, 'h1', 'html', '', 10, 10, '{"html":{"path":"/h/a.html","base_dir":"/web"}}'),
			('s-2', 2, 'h2', 'html', '', 30, 30, '{"html":{"path":"/h/a.html","base_dir":"/web"}}'),
			('s-1', 1, 'h3', 'html', '', 20, 20, '{"html":{"path":"docs/b.html","base_dir":"/web"}}'),
			('s-1', 2, 'u1', 'user_message', '', 21, 21, '{"text":"hi"}'),
			('s-1', 3, 'h4', 'html', '', 22, 22, 'not json')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}

	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}

	var how string
	var first, updated int64
	if err := db.QueryRowContext(ctx, `SELECT how, first_at, updated_at FROM page_owners WHERE path = '/h/a.html' AND thread_id = 's-1'`).Scan(&how, &first, &updated); err != nil {
		t.Fatal(err)
	}
	if how != "written" || first != 50 || updated != 50 {
		t.Errorf("kept row: how %q first %d updated %d; want written 50 50", how, first, updated)
	}
	// A second thread's claim on the same page is its own row.
	if _, err := db.ExecContext(ctx, `INSERT INTO page_owners (path, thread_id, how, first_at, updated_at) VALUES ('/h/a.html', 's-2', 'shown', 60, 60)`); err != nil {
		t.Fatalf("a second owner of one page: %v", err)
	}

	rows, err := db.QueryContext(ctx, `SELECT path, thread_id, record, at FROM page_storage_carry ORDER BY thread_id, path`)
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		path, thread string
		record       bool
		at           int64
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.path, &r.thread, &r.record, &r.at); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []row{
		{"", "s-1", false, 0},
		{"/h/a.html", "s-1", false, 50},
		{"/web/docs/b.html", "s-1", true, 20},
		{"", "s-2", false, 0},
		{"/h/a.html", "s-2", true, 30},
	}
	if !slices.Equal(got, want) {
		t.Errorf("carry list:\n got %v\nwant %v", got, want)
	}

	// Removing a thread removes its claims and what is left to carry for it.
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 's-2'`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`SELECT count(*) FROM page_owners WHERE thread_id = 's-2'`,
		`SELECT count(*) FROM page_storage_carry WHERE thread_id = 's-2'`,
	} {
		var n int
		if err := db.QueryRowContext(ctx, q).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s: %d, %v; want 0", q, n, err)
		}
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM page_owners WHERE path = '/h/a.html'`).Scan(&n); err != nil || n != 1 {
		t.Errorf("a.html's owners after s-2 went: %d, %v; want s-1's row", n, err)
	}
}
