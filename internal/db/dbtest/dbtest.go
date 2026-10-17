// Package dbtest hands tests a fresh, fully migrated database without replaying the
// migrations each time. The first call in a process migrates an empty database once and
// keeps its bytes; every call writes a copy under t.TempDir(). Under -race, applying the
// schema through modernc sqlite costs about a quarter of a second per database, and the
// thread store's tests alone open a few hundred (docs/notes/fake-claude-binary.md).
package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/db"
)

var (
	once     sync.Once
	template []byte
	buildErr error
)

// Path returns the path of a new, empty, fully migrated database under t.TempDir().
// db.Open on it finds every migration applied.
func Path(t testing.TB) string {
	t.Helper()
	once.Do(build)
	if buildErr != nil {
		t.Fatalf("dbtest: %v", buildErr)
	}
	p := filepath.Join(t.TempDir(), "db.sqlite")
	if err := os.WriteFile(p, template, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// Open is db.Open on Path; the database is closed when the test ends.
func Open(t testing.TB) *sql.DB {
	t.Helper()
	d, err := db.Open(context.Background(), Path(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// build migrates an empty database in a scratch directory and keeps the file's bytes.
// The WAL is checkpointed and truncated first so the main file is the whole database.
func build() {
	dir, err := os.MkdirTemp("", "dbtest")
	if err != nil {
		buildErr = err
		return
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "template.sqlite")
	ctx := context.Background()
	d, err := db.Open(ctx, path)
	if err != nil {
		buildErr = err
		return
	}
	if _, err := d.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		_ = d.Close()
		buildErr = fmt.Errorf("checkpoint template: %w", err)
		return
	}
	if err := d.Close(); err != nil {
		buildErr = err
		return
	}
	template, buildErr = os.ReadFile(path)
}
