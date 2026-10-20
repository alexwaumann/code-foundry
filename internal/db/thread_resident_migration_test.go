package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Migration 0041 adds the resident and reseed columns: a row written before it is an
// ordinary thread in its first epoch with no seed, and resident names are unique.
func TestThreadResidentMigration(t *testing.T) {
	ctx := context.Background()
	all, err := LoadMigrations(Migrations())
	if err != nil {
		t.Fatal(err)
	}
	before := fstest.MapFS{}
	for _, m := range all {
		if m.Version < 41 {
			before[m.Name] = &fstest.MapFile{Data: []byte(m.SQL)}
		}
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), before)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state) VALUES ('old', '/w', 1, 4)`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, db, Migrations()); err != nil {
		t.Fatal(err)
	}
	var kind, epoch, fresh int
	var name, prompt, prefix string
	if err := db.QueryRowContext(ctx, `SELECT kind, resident_name, epoch, system_prompt_append, fresh_start, seed_prefix FROM threads WHERE id = 'old'`).
		Scan(&kind, &name, &epoch, &prompt, &fresh, &prefix); err != nil {
		t.Fatal(err)
	}
	if kind != 0 || name != "" || epoch != 1 || prompt != "" || fresh != 0 || prefix != "" {
		t.Errorf("old row = kind %d %q epoch %d %q fresh %d %q", kind, name, epoch, prompt, fresh, prefix)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, kind, resident_name)
		VALUES ('r1', '/r', 2, 4, 1, 'ember'), ('n1', '/w', 3, 4, 0, ''), ('n2', '/w', 4, 4, 0, '')`); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO threads (id, worktree_path, created_at, state, kind, resident_name) VALUES ('r2', '/r', 5, 4, 1, 'ember')`)
	if err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Errorf("a second resident named ember: err = %v, want a UNIQUE failure", err)
	}
}
