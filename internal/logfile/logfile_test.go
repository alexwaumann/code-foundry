package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileRotates(t *testing.T) {
	tests := []struct {
		name     string
		existing string // the live file before Open
		writes   []string
		live     string
		rotated  string // "" when no .1 file
		rotates  int
	}{
		{"under the cap", "", []string{"aaaa\n", "bbbb\n"}, "aaaa\nbbbb\n", "", 0},
		{"write past the cap rotates first", "", []string{"aaaa\n", "bbbb\n", "cccc\n"}, "cccc\n", "aaaa\nbbbb\n", 1},
		{"a write larger than the cap still lands whole", "", []string{"aaaa\n", strings.Repeat("x", 30) + "\n"}, strings.Repeat("x", 30) + "\n", "aaaa\n", 1},
		{"over the cap at open rotates at open", strings.Repeat("o", 12), []string{"aaaa\n"}, "aaaa\n", strings.Repeat("o", 12), 1},
		{"appends to an existing file", "old\n", []string{"new\n"}, "old\nnew\n", "", 0},
		{"rotates twice", "", []string{"aaaaaaaa\n", "bbbbbbbb\n", "cccccccc\n"}, "cccccccc\n", "bbbbbbbb\n", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "logs", "d.log")
			if tt.existing != "" {
				if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(tt.existing), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			rotates := 0
			f, err := Open(path, 12, OnRotate(func(*os.File) { rotates++ }))
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.writes {
				if _, err := f.Write([]byte(w)); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			if got, _ := os.ReadFile(path); string(got) != tt.live {
				t.Errorf("live = %q, want %q", got, tt.live)
			}
			got, err := os.ReadFile(path + ".1")
			if tt.rotated == "" {
				if err == nil {
					t.Errorf("unexpected %s.1: %q", path, got)
				}
			} else if string(got) != tt.rotated {
				t.Errorf(".1 = %q (%v), want %q", got, err, tt.rotated)
			}
			if rotates != tt.rotates {
				t.Errorf("rotations = %d, want %d", rotates, tt.rotates)
			}
		})
	}
}

// New opens lazily: nothing is created until the first write.
func TestNewOpensOnFirstWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "p.log")
	f := New(path, 1<<10)
	if _, err := os.Stat(path); err == nil {
		t.Fatal("file created before the first write")
	}
	if _, err := f.Write([]byte("x\n")); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if got, _ := os.ReadFile(path); string(got) != "x\n" {
		t.Fatalf("file = %q", got)
	}
}
