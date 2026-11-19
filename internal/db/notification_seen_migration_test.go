package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0064 adds notifications.seen: a row written before it is seen (no badge for
// notifications the user already had), and a new row can say it is not.
func TestNotificationSeenMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 64 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO notifications (id, source, key, level, title, state, created_at, updated_at, arrived_at)
		VALUES ('n-old', 'ci', 'k', 'info', 'Hi', 'active', 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO notifications (id, source, key, level, title, state, created_at, updated_at, seen)
		VALUES ('n-new', 'ci', 'k2', 'info', 'Hi', 'active', 2, 2, 0)`); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int{"n-old": 1, "n-new": 0} {
		var seen int
		if err := db.QueryRowContext(ctx, `SELECT seen FROM notifications WHERE id = ?`, id).Scan(&seen); err != nil || seen != want {
			t.Errorf("%s: seen %d, %v; want %d", id, seen, err, want)
		}
	}
}
