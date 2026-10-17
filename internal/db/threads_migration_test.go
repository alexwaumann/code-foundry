package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Migration 0022 renames the session tables to thread tables: a database written
// before it keeps its rows, its foreign keys still cascade from threads, and the
// pull request index follows.
func TestThreadsMigrationKeepsRowsAndCascades(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 22 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO sessions (id, worktree_path, name, created_at, state, claude_session_id)
			VALUES ('s1', '/w', 'one', 1, 0, 'c1'), ('s2', '/w', 'two', 2, 0, '')`,
		`INSERT INTO session_pull_requests (session_id, slug, number, url, linked_at) VALUES ('s1', 'o/r', 7, 'u', 1)`,
		`INSERT INTO session_usage (session_id, model, tier, speed, day, requests, input, output, cache_read, cache_write_5m, cache_write_1h)
			VALUES ('s1', 'm', '', '', 'd', 1, 2, 3, 4, 5, 6)`,
		`INSERT INTO session_transcripts (session_id, claude_session_id, seq) VALUES ('s1', 'c1', 0)`,
		`INSERT INTO session_agent_runs (session_id, agent_id, claude_session_id, tool_use_id, description, agent_type, model, effort, spawn_depth, background, open, started_at)
			VALUES ('s1', 'a', 'c1', '', 'd', 't', '', '', 1, 0, 0, 1)`,
		`INSERT INTO session_source_usage (session_id, source, model, tier, speed, day, requests, input, output, cache_read, cache_write_5m, cache_write_1h)
			VALUES ('s1', 't:c1', 'm', '', '', 'd', 1, 2, 3, 4, 5, 6)`,
		`INSERT INTO session_thread_cache (session_id, slash_commands) VALUES ('s1', '[]')`,
		`INSERT INTO thread_items (session_id, ordinal, item_id, kind, parent_tool_use_id, created_at, updated_at, data)
			VALUES ('s1', 1, 'i', 'note', '', 1, 1, '{}'), ('s2', 1, 'j', 'note', '', 1, 1, '{}')`,
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
	for _, q := range []string{
		`SELECT count(*) FROM threads`,
		`SELECT count(*) FROM thread_pull_requests WHERE thread_id = 's1'`,
		`SELECT count(*) FROM thread_usage WHERE thread_id = 's1'`,
		`SELECT count(*) FROM thread_transcripts WHERE thread_id = 's1' AND claude_session_id = 'c1'`,
		`SELECT count(*) FROM thread_agent_runs WHERE thread_id = 's1'`,
		`SELECT count(*) FROM thread_source_usage WHERE thread_id = 's1'`,
		`SELECT count(*) FROM thread_cache WHERE thread_id = 's1'`,
		`SELECT count(*) FROM thread_items WHERE thread_id = 's1'`,
		`SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'thread_pull_requests_thread'`,
	} {
		want := 1
		if strings.HasSuffix(q, "FROM threads") {
			want = 2
		}
		if got := count(q); got != want {
			t.Errorf("%s = %d, want %d", q, got, want)
		}
	}
	var old int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE name LIKE 'session%'`).Scan(&old); err != nil || old != 0 {
		t.Errorf("session-named objects left = %d, %v", old, err)
	}

	// The foreign keys followed the rename: removing a thread cascades.
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{"thread_pull_requests", "thread_usage", "thread_transcripts", "thread_agent_runs", "thread_source_usage", "thread_cache", "thread_items"} {
		if n := count(`SELECT count(*) FROM ` + tbl + ` WHERE thread_id = 's1'`); n != 0 {
			t.Errorf("%s rows after cascade = %d", tbl, n)
		}
	}
	if n := count(`SELECT count(*) FROM thread_items WHERE thread_id = 's2'`); n != 1 {
		t.Errorf("s2 items = %d", n)
	}
	var fk string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE name = 'thread_items'`).Scan(&fk); err != nil || !strings.Contains(fk, `REFERENCES "threads"`) && !strings.Contains(fk, "REFERENCES threads") {
		t.Errorf("thread_items sql = %q, %v", fk, err)
	}
}
