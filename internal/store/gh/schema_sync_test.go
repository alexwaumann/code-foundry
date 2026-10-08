package gh

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/awaumann/code-foundry/internal/db"
)

// The daemon creates tables from internal/db/migrations, not schema.sql (which only
// the store's tests apply). Every gh_* table schema.sql defines must also come out of
// the daemon's migrations, or the store's cache writes fail in production only.
func TestDaemonMigrationsCreateEveryGhTable(t *testing.T) {
	ctx := context.Background()
	list := func(d DB) []string {
		rows, err := d.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gh_%' ORDER BY name`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		var out []string
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				t.Fatal(err)
			}
			out = append(out, n)
		}
		return out
	}
	daemonDB, err := db.Open(ctx, filepath.Join(t.TempDir(), "daemon.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = daemonDB.Close() })
	want, got := list(openTestDB(t)), list(daemonDB)
	if !slices.Equal(got, want) {
		t.Errorf("daemon migrations gh tables = %v, schema.sql = %v", got, want)
	}
}
