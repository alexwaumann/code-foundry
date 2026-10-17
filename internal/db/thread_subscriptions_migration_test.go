package db

import (
	"context"
	"path/filepath"
	"testing"
)

// Migration 0024 adds thread_subscriptions: a subscriber's rows go with its threads row.
func TestThreadSubscriptionsMigration(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('s1', '/w', 1, 4)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at)
		VALUES ('sub-1', 's1', 'thread', 's2', 'settled', 1)`); err != nil {
		t.Fatal(err)
	}
	var repeat, fired, last int64
	if err := db.QueryRowContext(ctx, `SELECT repeat, fired_count, last_fired_at FROM thread_subscriptions WHERE id = 'sub-1'`).
		Scan(&repeat, &fired, &last); err != nil || repeat != 0 || fired != 0 || last != 0 {
		t.Errorf("defaults = %d %d %d, %v", repeat, fired, last, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at)
		VALUES ('sub-2', 's-nope', 'thread', 's1', 'settled', 1)`); err == nil {
		t.Error("a subscriber that is not a thread was accepted")
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM threads WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM thread_subscriptions`).Scan(&n); err != nil || n != 0 {
		t.Errorf("rows after the subscriber went = %d, %v", n, err)
	}
}
