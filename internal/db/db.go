// Package db opens the daemon's SQLite database and applies schema migrations.
//
// The driver is modernc.org/sqlite (pure Go, no cgo). Every pooled connection runs with
// WAL journaling, a busy timeout, and foreign keys on. Transactions begin IMMEDIATE so
// concurrent writers wait on busy_timeout instead of failing with SQLITE_BUSY when a
// read lock is upgraded to a write lock.
//
// Migrations are embedded SQL files in migrations/, named NNNN_description.sql. They
// are applied in version order, each in its own transaction together with its
// schema_migrations row. A store adds its tables by adding the next numbered file;
// merged files are never edited.
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// BusyTimeout is how long a connection waits for a lock held by another connection.
const BusyTimeout = 5 * time.Second

//go:embed migrations/*.sql
var embedded embed.FS

// Migrations returns the embedded migration files, rooted at the migrations directory.
func Migrations() fs.FS {
	sub, err := fs.Sub(embedded, "migrations")
	if err != nil {
		// fs.Sub only fails for an invalid path literal.
		return embedded
	}
	return sub
}

// Open opens (creating if needed) the database at path and applies all embedded
// migrations. The caller closes the returned *sql.DB.
func Open(ctx context.Context, path string) (*sql.DB, error) {
	return OpenWith(ctx, path, Migrations())
}

// OpenWith is Open with an explicit migrations filesystem.
func OpenWith(ctx context.Context, path string, migrations fs.FS) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("db: open %s: %w", path, err)
	}
	if err := Migrate(ctx, db, migrations); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// dsn builds a modernc.org/sqlite DSN. _pragma values are applied to every new
// connection in the pool, which matters for per-connection pragmas like foreign_keys.
func dsn(path string) string {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", BusyTimeout.Milliseconds()))
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	return "file:" + path + "?" + q.Encode()
}

// Migration is one numbered schema change.
type Migration struct {
	Version int
	Name    string // file name
	SQL     string
}

// LoadMigrations reads NNNN_description.sql files from the top level of fsys, sorted
// by version. Versions must be positive and unique. Files without a .sql extension
// are ignored.
func LoadMigrations(fsys fs.FS) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("db: read migrations: %w", err)
	}
	var out []Migration
	seen := map[int]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || path.Ext(name) != ".sql" {
			continue
		}
		v, err := migrationVersion(name)
		if err != nil {
			return nil, err
		}
		if prev, dup := seen[v]; dup {
			return nil, fmt.Errorf("db: migrations %s and %s share version %d", prev, name, v)
		}
		seen[v] = name
		body, err := fs.ReadFile(fsys, name)
		if err != nil {
			return nil, fmt.Errorf("db: read migration %s: %w", name, err)
		}
		out = append(out, Migration{Version: v, Name: name, SQL: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// migrationVersion parses the numeric prefix of a name like "0001_repos.sql".
func migrationVersion(name string) (int, error) {
	prefix, _, ok := strings.Cut(name, "_")
	if !ok {
		return 0, fmt.Errorf("db: migration %q: want NNNN_description.sql", name)
	}
	v, err := strconv.Atoi(prefix)
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("db: migration %q: version must be a positive integer", name)
	}
	return v, nil
}

// Migrate applies every migration in fsys whose version is not yet recorded in
// schema_migrations. Each migration runs in its own transaction with its bookkeeping
// row, so a failure leaves the database at the previous version.
func Migrate(ctx context.Context, db *sql.DB, fsys fs.FS) error {
	migrations, err := LoadMigrations(fsys)
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT NOT NULL,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("db: create schema_migrations: %w", err)
	}
	applied, err := appliedVersions(ctx, db)
	if err != nil {
		return err
	}
	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}
		if err := apply(ctx, db, m); err != nil {
			return err
		}
	}
	return nil
}

func appliedVersions(ctx context.Context, db *sql.DB) (map[int]bool, error) {
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("db: read schema_migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("db: read schema_migrations: %w", err)
		}
		out[v] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("db: read schema_migrations: %w", err)
	}
	return out, nil
}

func apply(ctx context.Context, db *sql.DB, m Migration) (err error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("db: migration %s: begin: %w", m.Name, err)
	}
	defer func() {
		if err != nil {
			if rbErr := tx.Rollback(); rbErr != nil && !errors.Is(rbErr, sql.ErrTxDone) {
				err = errors.Join(err, fmt.Errorf("db: rollback: %w", rbErr))
			}
		}
	}()
	if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
		return fmt.Errorf("db: migration %s: %w", m.Name, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`,
		m.Version, m.Name, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("db: migration %s: record: %w", m.Name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("db: migration %s: commit: %w", m.Name, err)
	}
	return nil
}
