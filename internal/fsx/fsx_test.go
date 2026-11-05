package fsx

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestTempRoots(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	home := filepath.Join(base, "users", "me")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	homeLink := filepath.Join(base, "home-link")
	if err := os.Symlink(home, homeLink); err != nil {
		t.Fatal(err)
	}
	// /tmp is always there, in the forms it has on this machine.
	tmp := []string{"/tmp"}
	if r, err := filepath.EvalSymlinks("/tmp"); err == nil && r != "/tmp" {
		tmp = append(tmp, r)
	}
	tests := []struct {
		name, tmpdir string
		want         []string
	}{
		{"a folder of its own", real, append(slices.Clone(tmp), real)},
		{"a trailing slash, as macOS has it", real + "/", append(slices.Clone(tmp), real)},
		{"spelled and resolved", link, append(slices.Clone(tmp), link, real)},
		{"/tmp itself: no repeats", "/tmp", tmp},
		{"below home: allowed, home's rules still apply there", filepath.Join(home, "tmp"), append(slices.Clone(tmp), filepath.Join(home, "tmp"))},
		{"the filesystem's root", "/", tmp},
		{"home", home, tmp},
		{"above home", filepath.Dir(home), tmp},
		{"a link to home", homeLink, tmp},
		{"relative", "scratch", tmp},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TMPDIR", tt.tmpdir)
			if got := TempRoots(home); !slices.Equal(got, tt.want) {
				t.Errorf("TempRoots = %v, want %v", got, tt.want)
			}
		})
	}
}
