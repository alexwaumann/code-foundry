package db

import (
	"context"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// Migration 0023 adds the thread metadata columns: a row written before it gets none
// (empty strings, '[]' labels, zeros).
func TestThreadMetadataMigrationDefaults(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 23 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('s1', '/w', 1, 4)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var by, byName, brief, labels, summary, data string
	var status, at int64
	var budget, hit float64
	if err := db.QueryRowContext(ctx, `SELECT created_by, created_by_name, brief, labels, report_status, report_summary,
			report_data, report_at, budget_usd, budget_hit_usd FROM threads WHERE id = 's1'`).
		Scan(&by, &byName, &brief, &labels, &status, &summary, &data, &at, &budget, &hit); err != nil {
		t.Fatal(err)
	}
	if by != "" || byName != "" || brief != "" || labels != "[]" || status != 0 || summary != "" || data != "" || at != 0 || budget != 0 || hit != 0 {
		t.Errorf("defaults = %q %q %q %q %d %q %q %d %v %v", by, byName, brief, labels, status, summary, data, at, budget, hit)
	}
	// REAL keeps a fraction of a cent.
	if _, err := db.ExecContext(ctx, `UPDATE threads SET budget_usd = 0.0001 WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT budget_usd FROM threads WHERE id = 's1'`).Scan(&budget); err != nil || budget != 0.0001 {
		t.Errorf("budget = %v, %v", budget, err)
	}
}
