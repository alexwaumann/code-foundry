package fsx

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// A home file opens by its resolved path; a link at the name or above it, as a swap would put
// there after the path was resolved, fails the open.
func TestOpenHomeRefusesLinks(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	mk := func(p, s string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mk(filepath.Join(home, "dir", "plain.txt"), "plain")
	mk(filepath.Join(home, "secret", "x.txt"), "secret")
	for link, target := range map[string]string{"dir/link.txt": "secret/x.txt", "linked": "secret"} {
		if err := os.Symlink(filepath.Join(home, target), filepath.Join(home, link)); err != nil {
			t.Fatal(err)
		}
	}
	r := ReadRoots{Home: home}
	f, err := r.open(filepath.Join(home, "dir", "plain.txt"))
	if err != nil {
		t.Fatalf("open(plain) = %v", err)
	}
	_ = f.Close()
	for _, p := range []string{"dir/link.txt", "linked/x.txt"} {
		f, err := r.open(filepath.Join(home, p))
		if err == nil {
			_ = f.Close()
			t.Errorf("open(%s) succeeded through a link", p)
		} else if !errors.Is(err, syscall.ELOOP) {
			t.Errorf("open(%s) = %v, want ELOOP", p, err)
		}
	}
}
