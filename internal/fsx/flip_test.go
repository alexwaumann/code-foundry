package fsx_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/fsx/fsxtest"
)

// Anything on the machine can replace what is in a temp folder between ReadFile's check and
// its read. Each row flips a name while ReadFile reads it: no read may reach the file
// outside every root, and none may block.
func TestReadFileFlip(t *testing.T) {
	const secret = "outside every root"
	tests := []struct {
		name, flip, read string
		makes            func(outside string) []fsxtest.Maker
	}{
		{"a file and a link out", "private/tmp/x.txt", "tmp/x.txt", func(outside string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.Link(filepath.Join(outside, "x.txt"))}
		}},
		{"a folder and a link out", "private/tmp/d", "tmp/d/x.txt", func(outside string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.Dir("x.txt", "mine"), fsxtest.Link(outside)}
		}},
		{"a file and a FIFO", "private/tmp/x.txt", "tmp/x.txt", func(string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.File("mine"), fsxtest.FIFO()}
		}},
		{"a folder and a FIFO", "private/tmp/d", "tmp/d/x.txt", func(string) []fsxtest.Maker {
			return []fsxtest.Maker{fsxtest.Dir("x.txt", "mine"), fsxtest.FIFO()}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			at := func(p string) string { return filepath.Join(base, p) }
			for _, d := range []string{"home", "private/tmp", "outside"} {
				if err := os.MkdirAll(at(d), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(at("outside/x.txt"), []byte(secret), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(at("private/tmp"), at("tmp")); err != nil {
				t.Fatal(err)
			}
			roots := fsx.ReadRoots{Home: at("home"), Temp: []string{at("tmp"), at("private/tmp")}}
			fsxtest.Flip(t, at(tt.flip), tt.makes(at("outside"))...)
			fsxtest.Hammer(t, func() {
				f, err := fsx.ReadFile(roots, "", at(tt.read), 0)
				if err == nil && strings.Contains(string(f.Contents), secret) {
					t.Errorf("read %q from outside every root", f.Contents)
				}
			})
		})
	}
}
