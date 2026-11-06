package main

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestWebStorageID(t *testing.T) {
	user, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", user)
	def := filepath.Join(user, paths.DirName)
	scratch := filepath.Join(user, "scratch")
	for _, dir := range []string{def, scratch} {
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{"to-default": def, "to-scratch": scratch} {
		if err := os.Symlink(target, filepath.Join(user, link)); err != nil {
			t.Fatal(err)
		}
	}
	scratchID := webStorageID(paths.New(scratch))

	tests := []struct {
		name string
		home string
		want string // "" is the default store
	}{
		{"default home", def, ""},
		{"default home, trailing slash", def + "/", ""},
		{"default home, another spelling", filepath.Join(scratch, "..", paths.DirName), ""},
		{"default home through a symlink", filepath.Join(user, "to-default"), ""},
		{"scratch home", scratch, scratchID},
		{"scratch home, trailing slash", scratch + "/", scratchID},
		{"scratch home through a symlink", filepath.Join(user, "to-scratch"), scratchID},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := webStorageID(paths.New(tt.home)); got != tt.want {
				t.Errorf("webStorageID(%q) = %q, want %q", tt.home, got, tt.want)
			}
		})
	}
}

func TestWebStorageIDOfOtherHomes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	uuid := regexp.MustCompile(`^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$`)
	seen := map[string]string{}
	for _, home := range []string{"/tmp/a", "/tmp/b", "/tmp/not-there/yet", "/Users/someone/.code-foundry"} {
		id := webStorageID(paths.New(home))
		if !uuid.MatchString(id) {
			t.Errorf("%s: %q is no version 4 UUID", home, id)
		}
		if other, dup := seen[id]; dup {
			t.Errorf("%s and %s share %s", home, other, id)
		}
		seen[id] = home
	}
}

// With no user home to compare with, a set home is not taken for the default one.
func TestWebStorageIDWithoutUserHome(t *testing.T) {
	t.Setenv("HOME", "")
	if id := webStorageID(paths.New("/tmp/a")); id == "" {
		t.Error("the default store, for a home that cannot be shown to be the default one")
	}
}
