package project

import (
	"os"
	"path/filepath"
	"testing"
)

// side is what a test expects of one FileVersion.
type side struct {
	present, truncated, binary bool
	contents                   string // compared when present and not truncated
	size                       int    // len(contents) when truncated
}

func checkSide(t *testing.T, which string, got FileVersion, want side) {
	t.Helper()
	if got.Present != want.present || got.Truncated != want.truncated || got.Binary != want.binary {
		t.Errorf("%s: present/truncated/binary = %t/%t/%t, want %t/%t/%t", which,
			got.Present, got.Truncated, got.Binary, want.present, want.truncated, want.binary)
	}
	switch {
	case want.truncated && len(got.Contents) != want.size:
		t.Errorf("%s: len(contents) = %d, want %d", which, len(got.Contents), want.size)
	case !want.truncated && string(got.Contents) != want.contents:
		t.Errorf("%s: contents = %q, want %q", which, got.Contents, want.contents)
	}
}

// TestReadWorktreeFileSymlinks: a symlink reads as its target, as git stores it, and a
// path through a symlinked directory leaving the worktree is not read.
func TestReadWorktreeFileSymlinks(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	wt, out := filepath.Join(dir, "wt"), filepath.Join(dir, "out")
	for _, d := range []string{wt, out} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, filepath.Join(out, "secret"), "no\n")
	if err := os.Symlink("../out/secret", filepath.Join(wt, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(wt, "dirlink")); err != nil {
		t.Fatal(err)
	}
	v, err := readWorktreeFile(wt, "link")
	if err != nil || !v.Present || string(v.Contents) != "../out/secret" {
		t.Errorf("link = %+v, %v; want its target", v, err)
	}
	v, err = readWorktreeFile(wt, "dirlink/secret")
	if err != nil || v.Present {
		t.Errorf("dirlink/secret = %+v, %v; want not present", v, err)
	}
}
