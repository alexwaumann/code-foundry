package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0039 adds thread_pull_requests.source and via_thread_id: a link written
// before it came from Claude's pr-link record and came through no child.
func TestThreadPullRequestSourceMigrationDefault(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 39 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, created_worktree)
		VALUES ('s1', '/w', 1, 4, 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_pull_requests (thread_id, slug, number, url, linked_at)
		VALUES ('s1', 'o/r', 5, 'https://github.com/o/r/pull/5', 1)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var source, via string
	if err := db.QueryRowContext(ctx, `SELECT source, via_thread_id FROM thread_pull_requests WHERE thread_id = 's1'`).
		Scan(&source, &via); err != nil || source != "claude" || via != "" {
		t.Errorf("source %q, via %q, %v; want claude and empty", source, via, err)
	}
	// A new row names its own.
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_pull_requests (thread_id, slug, number, url, linked_at, source, via_thread_id)
		VALUES ('s1', 'o/r', 6, 'https://github.com/o/r/pull/6', 2, 'child', 's2')`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT source, via_thread_id FROM thread_pull_requests WHERE number = 6`).
		Scan(&source, &via); err != nil || source != "child" || via != "s2" {
		t.Errorf("source %q, via %q, %v; want child and s2", source, via, err)
	}
}
