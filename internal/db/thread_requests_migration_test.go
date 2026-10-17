package db

import (
	"context"
	"path/filepath"
	"testing"
)

// Migration 0025 adds thread_requests: one key per creator, gone with its thread.
func TestThreadRequestsMigration(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('s1', '/w', 1, 4)`); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO thread_requests (creator, request_id, thread_id, created_at) VALUES (?, ?, ?, 1)`
	if _, err := db.ExecContext(ctx, insert, "", "k1", "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, insert, "s-parent", "k1", "s1"); err != nil {
		t.Errorf("the same key of another creator: %v", err)
	}
	if _, err := db.ExecContext(ctx, insert, "", "k1", "s1"); err == nil {
		t.Error("a creator's key twice was accepted")
	}
	if _, err := db.ExecContext(ctx, insert, "", "k2", "s-nope"); err == nil {
		t.Error("a key for a thread that does not exist was accepted")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM thread_requests`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows after the thread went = %d, %v", n, err)
	}
}
