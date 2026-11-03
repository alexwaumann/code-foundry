package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"
)

// Migration 0054 adds the thread search index: every thread that exists is listed for the
// thread store's backfill, and a document goes with the last thread_items row holding its
// item id, also when a thread's removal cascades to its items.
func TestThreadSearchMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 54 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, created_by)
		VALUES ('a', '/w', 1, 4, ''), ('fork', '/w', 2, 4, ''), ('b', '/w', 3, 4, '')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_items (thread_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data)
		VALUES ('a', 1, 'u1', 'user_message', '', 1, 1, '{"text":"shared"}'), ('fork', 1, 'u1', 'user_message', '', 1, 1, '{"text":"shared"}'),
		('a', 2, 'u2', 'user_message', '', 2, 2, '{"text":"only a"}')`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	if got := column(t, db, `SELECT thread_id FROM search_backfill ORDER BY thread_id`); !slices.Equal(got, []string{"a", "b", "fork"}) {
		t.Errorf("search_backfill = %q, want every thread", got)
	}
	// The thread store writes the documents (internal/store/thread/search_index.go); here
	// by hand.
	for i, id := range []string{"u1", "u2"} {
		if _, err := db.ExecContext(ctx, `INSERT INTO search_docs (id, item_id, hash) VALUES (?, ?, 0)`, i+1, id); err != nil {
			t.Fatal(err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO search_fts (rowid, text) VALUES (?, ?)`, i+1, "text of "+id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 'a'`); err != nil {
		t.Fatal(err)
	}
	if got := column(t, db, `SELECT item_id FROM search_docs ORDER BY item_id`); !slices.Equal(got, []string{"u1"}) {
		t.Errorf("documents after removing a = %q, want u1 (the fork holds it)", got)
	}
	if got := column(t, db, `SELECT rowid FROM search_fts WHERE search_fts MATCH '"text of"' ORDER BY rowid`); !slices.Equal(got, []string{"1"}) {
		t.Errorf("index rows after removing a = %q, want u1's", got)
	}
	if got := column(t, db, `SELECT thread_id FROM search_backfill ORDER BY thread_id`); !slices.Equal(got, []string{"b", "fork"}) {
		t.Errorf("search_backfill after removing a = %q", got)
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 'fork'`); err != nil {
		t.Fatal(err)
	}
	if got := column(t, db, `SELECT item_id FROM search_docs`); len(got) != 0 {
		t.Errorf("documents after removing the fork = %q, want none", got)
	}
	if got := column(t, db, `SELECT rowid FROM search_fts WHERE search_fts MATCH '"text of"'`); len(got) != 0 {
		t.Errorf("index rows after removing the fork = %q, want none", got)
	}
}

// column returns query's first column as strings.
func column(t *testing.T, db *sql.DB, query string) []string {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// After every migration, thread_items still has what thread search needs: a later
// migration that rebuilds thread_items (create, copy, drop, rename) drops its triggers and
// indexes, and must make these again.
func TestThreadSearchSchemaAfterAllMigrations(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, want := range []struct{ typ, name string }{
		{"trigger", "thread_items_search_gone"},
		{"index", "thread_items_item_id"},
	} {
		got := column(t, db, `SELECT tbl_name FROM sqlite_master WHERE type = '`+want.typ+`' AND name = '`+want.name+`'`)
		if !slices.Equal(got, []string{"thread_items"}) {
			t.Errorf("%s %s on %q, want on thread_items", want.typ, want.name, got)
		}
	}
	// The search query's plan depends on these columns, in this order (thread.TestSearchQueryPlan).
	if got := column(t, db, `SELECT name FROM pragma_index_info('thread_items_item_id') ORDER BY seqno`); !slices.Equal(got, []string{"item_id", "thread_id", "parent_tool_use_id"}) {
		t.Errorf("thread_items_item_id columns %q, want item_id, thread_id, parent_tool_use_id", got)
	}
	for _, table := range []string{"search_docs", "search_fts", "search_backfill"} {
		if got := column(t, db, `SELECT name FROM sqlite_master WHERE name = '`+table+`'`); len(got) != 1 {
			t.Errorf("table %s missing", table)
		}
	}
}
