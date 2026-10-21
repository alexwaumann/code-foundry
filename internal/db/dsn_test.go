package db

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// A config home with characters that mean something in a URI still gets its database
// where it asked for it.
func TestOpenPathWithURICharacters(t *testing.T) {
	for _, dir := range []string{"hash#x", "q?x", "pct%20x", "space x", "amp&x=1", "semi;colon"} {
		t.Run(dir, func(t *testing.T) {
			base := t.TempDir()
			home := filepath.Join(base, dir)
			if err := os.Mkdir(home, 0o755); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(home, "db.sqlite")
			d, err := Open(context.Background(), path)
			if err != nil {
				t.Fatalf("open %s: %v", path, err)
			}
			var fk int
			if err := d.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
				t.Errorf("foreign_keys = %d, %v: the pragmas were lost", fk, err)
			}
			_ = d.Close()
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("database not at %s: %v", path, err)
			}
			entries, _ := os.ReadDir(base)
			var names []string
			for _, e := range entries {
				names = append(names, e.Name())
			}
			if !slices.Equal(names, []string{dir}) {
				t.Errorf("%s holds %v, want just %s", base, names, dir)
			}
		})
	}
}
