package fsx

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// The way to a tree follows no link and waits on nothing, and the Root it gives stays in it.
func TestOpenTree(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at := func(p string) string { return filepath.Join(base, p) }
	for _, f := range []string{"private/tmp/a/b/x.txt", "private/tmp/other/x.txt", "private/tmp/top.txt"} {
		if err := os.MkdirAll(filepath.Dir(at(f)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at(f), []byte(f), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for link, target := range map[string]string{
		"tmp":                 "private/tmp",
		"private/tmp/l":       "private/tmp/other",
		"private/tmp/a/b/out": "private/tmp/other/x.txt",
	} {
		if err := os.Symlink(at(target), at(link)); err != nil {
			t.Fatal(err)
		}
	}
	if err := syscall.Mkfifo(at("private/tmp/pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, top, dir string
		read           string
		want           string // the file read holds this; "" when the open must fail
	}{
		{"the temp folder, through its link", "tmp", "tmp", "top.txt", "private/tmp/top.txt"},
		{"a folder", "tmp", "tmp/a", "b/x.txt", "private/tmp/a/b/x.txt"},
		{"deeper", "private/tmp", "private/tmp/a/b", "x.txt", "private/tmp/a/b/x.txt"},
		{"a link at the folder", "tmp", "tmp/l", "", ""},
		{"a link on the way", "tmp", "tmp/l/x", "", ""},
		{"a file", "tmp", "tmp/top.txt", "", ""},
		{"a FIFO", "tmp", "tmp/pipe", "", ""},
		{"missing", "tmp", "tmp/nope", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root, err := OpenTree(at(tt.top), at(tt.dir))
			if tt.want == "" {
				if err == nil {
					_ = root.Close()
					t.Fatal("opened it")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = root.Close() }()
			got, err := root.ReadFile(tt.read)
			if err != nil || string(got) != tt.want {
				t.Errorf("read %q, %v, want %q", got, err, tt.want)
			}
		})
	}
	root, err := OpenTree(at("tmp"), at("tmp/a/b"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	if _, err := root.Open("out"); err == nil {
		t.Error("the Root followed a link out of its tree")
	}
}
