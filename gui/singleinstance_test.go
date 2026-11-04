package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSingleInstanceID(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(home, link); err != nil {
		t.Fatal(err)
	}
	id := singleInstanceID(home)
	if !strings.HasPrefix(id, "dev.alexwaumann.codefoundry.gui.") || strings.ContainsAny(id, "/ ") {
		t.Errorf("id %q is no file name", id)
	}
	if got := singleInstanceID(home + "/"); got != id {
		t.Errorf("a trailing slash: %q, want %q", got, id)
	}
	if got := singleInstanceID(link); got != id {
		t.Errorf("through a symlink: %q, want %q", got, id)
	}
	if got := singleInstanceID(filepath.Join(dir, "other")); got == id {
		t.Errorf("another home has the same id %q", got)
	}
}
