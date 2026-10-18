package fsx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReadFile(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "home")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(root, "proj", "docs"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p string, b []byte) {
		t.Helper()
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	proj := filepath.Join(root, "proj")
	write(filepath.Join(proj, "README.md"), []byte("# hi\n"))
	write(filepath.Join(proj, "main.go"), []byte("package main\n"))
	write(filepath.Join(proj, "app.ts"), []byte("export {}\n"))
	png := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), make([]byte, 16)...)
	write(filepath.Join(proj, "logo.png"), png)
	write(filepath.Join(proj, "blob"), []byte("a\x00b"))
	big := bytes.Repeat([]byte("0123456789abcde\n"), MaxReadBytes/16+10)
	write(filepath.Join(proj, "big.txt"), big)
	write(filepath.Join(outside, "secret"), []byte("no"))
	symlink := func(target, link string) {
		t.Helper()
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
	}
	symlink(filepath.Join(outside, "secret"), filepath.Join(proj, "escape"))
	symlink(filepath.Join(proj, "README.md"), filepath.Join(proj, "docs", "readme-link"))
	symlink(filepath.Join(proj, "README.md"), filepath.Join(outside, "back-in"))

	tests := []struct {
		name, baseDir, path string
		max                 int64
		want                FileContents // Contents compared by length only
		wantLen             int
		invalid             bool
	}{
		{name: "relative", baseDir: proj, path: "README.md", wantLen: 5,
			want: FileContents{Path: filepath.Join(proj, "README.md"), Size: 5, MIMEType: "text/markdown"}},
		{name: "relative cleaned", baseDir: proj, path: "docs/../main.go", wantLen: 13,
			want: FileContents{Path: filepath.Join(proj, "main.go"), Size: 13, MIMEType: "text/plain; charset=utf-8"}},
		{name: "absolute ignores base", baseDir: "", path: filepath.Join(proj, "app.ts"), wantLen: 10,
			want: FileContents{Path: filepath.Join(proj, "app.ts"), Size: 10, MIMEType: "text/typescript"}},
		{name: "tilde", path: "~/proj/README.md", wantLen: 5,
			want: FileContents{Path: filepath.Join(proj, "README.md"), Size: 5, MIMEType: "text/markdown"}},
		{name: "symlink inside", baseDir: proj, path: "docs/readme-link", wantLen: 5,
			want: FileContents{Path: filepath.Join(proj, "docs", "readme-link"), Size: 5, MIMEType: "text/plain; charset=utf-8"}},
		{name: "symlink outside to inside", path: filepath.Join(outside, "back-in"), wantLen: 5,
			want: FileContents{Path: filepath.Join(outside, "back-in"), Size: 5, MIMEType: "text/plain; charset=utf-8"}},
		{name: "image", baseDir: proj, path: "logo.png", wantLen: len(png),
			want: FileContents{Path: filepath.Join(proj, "logo.png"), Size: int64(len(png)), MIMEType: "image/png", Binary: true}},
		{name: "nul", baseDir: proj, path: "blob", wantLen: 3,
			want: FileContents{Path: filepath.Join(proj, "blob"), Size: 3, MIMEType: "application/octet-stream", Binary: true}},
		{name: "truncated default", baseDir: proj, path: "big.txt", wantLen: MaxReadBytes,
			want: FileContents{Path: filepath.Join(proj, "big.txt"), Size: int64(len(big)), Truncated: true, MIMEType: "text/plain"}},
		{name: "truncated max", baseDir: proj, path: "big.txt", max: 20, wantLen: 20,
			want: FileContents{Path: filepath.Join(proj, "big.txt"), Size: int64(len(big)), Truncated: true, MIMEType: "text/plain"}},
		{name: "max above limit", baseDir: proj, path: "big.txt", max: 4 * MaxReadBytes, wantLen: MaxReadBytes,
			want: FileContents{Path: filepath.Join(proj, "big.txt"), Size: int64(len(big)), Truncated: true, MIMEType: "text/plain"}},
		{name: "directory", baseDir: proj, path: "docs",
			want: FileContents{Path: filepath.Join(proj, "docs"), IsDir: true}},
		{name: "missing", baseDir: proj, path: "nope.md",
			want: FileContents{Path: filepath.Join(proj, "nope.md"), NotFound: true}},
		{name: "outside home", path: filepath.Join(outside, "secret"), invalid: true},
		{name: "dotdot out of home", baseDir: proj, path: "../../outside/secret", invalid: true},
		{name: "missing outside home", path: filepath.Join(outside, "nope"), invalid: true},
		{name: "symlink out of home", baseDir: proj, path: "escape", invalid: true},
		{name: "relative without base", path: "README.md", invalid: true},
		{name: "empty", baseDir: proj, invalid: true},
		{name: "negative max", baseDir: proj, path: "README.md", max: -1, invalid: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadFile(root, tt.baseDir, tt.path, tt.max)
			if tt.invalid {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want ErrInvalidArgument", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Contents) != tt.wantLen {
				t.Errorf("len(contents) = %d, want %d", len(got.Contents), tt.wantLen)
			}
			if !tt.want.NotFound && got.ModifiedAt.IsZero() {
				t.Error("modified at is zero")
			}
			got.Contents, got.ModifiedAt = nil, tt.want.ModifiedAt
			if tt.want.IsDir {
				got.Size = 0 // a directory's size is whatever the filesystem says
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got  %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestDetectMIME(t *testing.T) {
	tests := []struct {
		name, head, want string
		text             bool
	}{
		{"notes.MD", "# x", "text/markdown", true},
		{"index.html", "<p>", "text/html", true},
		{"icon.svg", "<svg/>", "image/svg+xml", true},
		{"data.json", "{}", "application/json", true},
		{"Makefile", "all:\n", "text/plain; charset=utf-8", true},
		{"photo.jpeg", "", "image/jpeg", false},
		{"doc", "%PDF-1.7", "application/pdf", false},
		{"blob", "\x00\x01\x02", "application/octet-stream", false},
	}
	for _, tt := range tests {
		got := DetectMIME(tt.name, []byte(tt.head))
		if got != tt.want || TextMIME(got) != tt.text {
			t.Errorf("DetectMIME(%q) = %q (text %t), want %q (text %t)", tt.name, got, TextMIME(got), tt.want, tt.text)
		}
	}
	if !LooksBinary([]byte("ab\x00")) || LooksBinary([]byte(strings.Repeat("a", BinarySniff)+"\x00")) {
		t.Error("LooksBinary checks only the first BinarySniff bytes for NUL")
	}
}
