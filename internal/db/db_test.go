package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestOpenPragmasAndEmbeddedMigrations(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "db.sqlite")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}

	var mode string
	if err := db.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v; want wal", mode, err)
	}
	// Per-connection pragmas must hold on every pooled connection, so check several.
	conns := make([]*sql.Conn, 3)
	for i := range conns {
		c, err := db.Conn(ctx)
		if err != nil {
			t.Fatal(err)
		}
		conns[i] = c
		var fk, busy int
		if err := c.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
			t.Fatalf("conn %d foreign_keys = %d, %v", i, fk, err)
		}
		if err := c.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&busy); err != nil || busy != int(BusyTimeout.Milliseconds()) {
			t.Fatalf("conn %d busy_timeout = %d, %v", i, busy, err)
		}
	}
	for _, c := range conns {
		_ = c.Close()
	}

	if _, err := db.ExecContext(ctx, `INSERT INTO repos (id, path, name, registered_at) VALUES ('a', '/x', 'x', 1)`); err != nil {
		t.Fatalf("repos table missing: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	// Reopening applies nothing new and keeps data.
	db2, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db2.Close() }()
	var n int
	if err := db2.QueryRowContext(ctx, `SELECT count(*) FROM repos`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("repos rows = %d, %v", n, err)
	}
	all, err := LoadMigrations(Migrations())
	if err != nil || len(all) == 0 {
		t.Fatalf("embedded migrations = %v, %v", all, err)
	}
	if err := db2.QueryRowContext(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&n); err != nil || n != len(all) {
		t.Fatalf("schema_migrations rows = %d, %v; want %d", n, err, len(all))
	}
}

func TestMigrateOrderAndIncremental(t *testing.T) {
	ctx := context.Background()
	fsys := fstest.MapFS{
		"0002_b.sql": {Data: []byte(`INSERT INTO t (v) VALUES ('second');`)},
		"0001_a.sql": {Data: []byte(`CREATE TABLE t (v TEXT); INSERT INTO t (v) VALUES ('first');`)},
		"README.md":  {Data: []byte(`ignored`)},
		"0010_c.sql": {Data: []byte(`INSERT INTO t (v) VALUES ('tenth');`)},
	}
	db, err := OpenWith(ctx, filepath.Join(t.TempDir(), "db.sqlite"), fsys)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := values(t, db); strings.Join(got, ",") != "first,second,tenth" {
		t.Fatalf("order = %v", got)
	}

	// A new migration applies exactly once; old ones do not re-run.
	fsys["0011_d.sql"] = &fstest.MapFile{Data: []byte(`INSERT INTO t (v) VALUES ('eleventh');`)}
	for range 2 {
		if err := Migrate(ctx, db, fsys); err != nil {
			t.Fatal(err)
		}
	}
	if got := values(t, db); strings.Join(got, ",") != "first,second,tenth,eleventh" {
		t.Fatalf("after incremental = %v", got)
	}
}

func TestMigrateFailureRollsBack(t *testing.T) {
	ctx := context.Background()
	fsys := fstest.MapFS{
		"0001_a.sql": {Data: []byte(`CREATE TABLE t (v TEXT);`)},
		"0002_b.sql": {Data: []byte(`INSERT INTO t (v) VALUES ('x'); THIS IS NOT SQL;`)},
	}
	path := filepath.Join(t.TempDir(), "db.sqlite")
	if _, err := OpenWith(ctx, path, fsys); err == nil || !strings.Contains(err.Error(), "0002_b.sql") {
		t.Fatalf("err = %v, want failure naming 0002_b.sql", err)
	}
	fsys["0002_b.sql"] = &fstest.MapFile{Data: []byte(`INSERT INTO t (v) VALUES ('fixed');`)}
	db, err := OpenWith(ctx, path, fsys)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := values(t, db); strings.Join(got, ",") != "fixed" {
		t.Fatalf("values = %v; the failed migration's insert should have rolled back", got)
	}
}

func TestLoadMigrationsErrors(t *testing.T) {
	tests := []struct {
		name string
		fsys fstest.MapFS
		want string
	}{
		{"no underscore", fstest.MapFS{"0001.sql": {}}, "want NNNN_description.sql"},
		{"not a number", fstest.MapFS{"abc_x.sql": {}}, "positive integer"},
		{"zero", fstest.MapFS{"0000_x.sql": {}}, "positive integer"},
		{"duplicate", fstest.MapFS{"0001_a.sql": {}, "01_b.sql": {}}, "share version 1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := LoadMigrations(tt.fsys)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}
}

func values(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT v FROM t ORDER BY rowid`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
