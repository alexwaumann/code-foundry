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

// Migration 0034 adds thread_subscriptions.args, '{}' for rows that do not give it.
func TestThreadSubscriptionArgsMigration(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('s1', '/w', 1, 4)`); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at)
			VALUES ('sub-1', 's1', 'thread', 's2', 'settled', 1)`,
		`INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at, args)
			VALUES ('sub-2', 's1', 'plugin', 'hello/tick', 'fired', 1, '{"every":"2s"}')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for id, want := range map[string]string{"sub-1": "{}", "sub-2": `{"every":"2s"}`} {
		var args string
		if err := db.QueryRowContext(ctx, `SELECT args FROM thread_subscriptions WHERE id = ?`, id).Scan(&args); err != nil || args != want {
			t.Errorf("%s args = %q, %v; want %q", id, args, err, want)
		}
	}
}

// Migration 0044 adds thread_subscriptions.note, empty for rows that do not give it.
func TestThreadSubscriptionNoteMigration(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, q := range []string{
		`INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('s1', '/w', 1, 4)`,
		`INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at)
			VALUES ('sub-1', 's1', 'timer', 'every:30m', 'fired', 1)`,
		`INSERT INTO thread_subscriptions (id, subscriber_thread_id, target_kind, target_id, condition, created_at, note)
			VALUES ('sub-2', 's1', 'timer', 'every:1h', 'fired', 1, 'check the deploy')`,
	} {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatal(err)
		}
	}
	for id, want := range map[string]string{"sub-1": "", "sub-2": "check the deploy"} {
		var note string
		if err := db.QueryRowContext(ctx, `SELECT note FROM thread_subscriptions WHERE id = ?`, id).Scan(&note); err != nil || note != want {
			t.Errorf("%s note = %q, %v; want %q", id, note, err, want)
		}
	}
}
