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
	small := bytes.Repeat([]byte("0123456789abcde\n"), 1000) // over BinarySniff, under 1 MiB
	write(filepath.Join(proj, "small.txt"), small)
	write(filepath.Join(proj, "notes"), big) // sniffed as text
	// Large binaries are sparse: a PNG or NUL head, then a hole to the size.
	sparse := func(name string, head []byte, size int64) {
		t.Helper()
		p := filepath.Join(proj, name)
		write(p, head)
		if err := os.Truncate(p, size); err != nil {
			t.Fatal(err)
		}
	}
	sparse("photo.png", png, 3<<20)
	sparse("wide.png", png, 2<<20)
	sparse("huge.bin", []byte("\x00blob"), MaxBinaryReadBytes+10)
	sparse("nul.txt", []byte("a\x00b"), 2<<20) // a text extension with a NUL is binary
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
		{name: "text over cap with binary max", baseDir: proj, path: "big.txt", max: MaxBinaryReadBytes, wantLen: MaxReadBytes,
			want: FileContents{Path: filepath.Join(proj, "big.txt"), Size: int64(len(big)), Truncated: true, MIMEType: "text/plain"}},
		{name: "sniffed text over cap with binary max", baseDir: proj, path: "notes", max: MaxBinaryReadBytes, wantLen: MaxReadBytes,
			want: FileContents{Path: filepath.Join(proj, "notes"), Size: int64(len(big)), Truncated: true, MIMEType: "text/plain; charset=utf-8"}},
		{name: "text under cap with binary max", baseDir: proj, path: "small.txt", max: MaxBinaryReadBytes, wantLen: len(small),
			want: FileContents{Path: filepath.Join(proj, "small.txt"), Size: int64(len(small)), MIMEType: "text/plain"}},
		{name: "image whole with binary max", baseDir: proj, path: "photo.png", max: MaxBinaryReadBytes, wantLen: 3 << 20,
			want: FileContents{Path: filepath.Join(proj, "photo.png"), Size: 3 << 20, MIMEType: "image/png", Binary: true}},
		{name: "image whole with max above limit", baseDir: proj, path: "photo.png", max: 4 * MaxBinaryReadBytes, wantLen: 3 << 20,
			want: FileContents{Path: filepath.Join(proj, "photo.png"), Size: 3 << 20, MIMEType: "image/png", Binary: true}},
		{name: "image default max", baseDir: proj, path: "wide.png", wantLen: MaxReadBytes,
			want: FileContents{Path: filepath.Join(proj, "wide.png"), Size: 2 << 20, Truncated: true, MIMEType: "image/png", Binary: true}},
		{name: "image under head", baseDir: proj, path: "photo.png", max: 20, wantLen: 20,
			want: FileContents{Path: filepath.Join(proj, "photo.png"), Size: 3 << 20, Truncated: true, MIMEType: "image/png", Binary: true}},
		{name: "binary over limit", baseDir: proj, path: "huge.bin", max: 4 * MaxBinaryReadBytes, wantLen: MaxBinaryReadBytes,
			want: FileContents{Path: filepath.Join(proj, "huge.bin"), Size: MaxBinaryReadBytes + 10, Truncated: true, MIMEType: "application/octet-stream", Binary: true}},
		{name: "nul in text extension", baseDir: proj, path: "nul.txt", max: MaxBinaryReadBytes, wantLen: 2 << 20,
			want: FileContents{Path: filepath.Join(proj, "nul.txt"), Size: 2 << 20, MIMEType: "text/plain", Binary: true}},
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
			got, err := ReadFile(ReadRoots{Home: root}, tt.baseDir, tt.path, tt.max)
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
			got.Contents, got.ModifiedAt, got.RealPath, got.Mode = nil, tt.want.ModifiedAt, "", 0
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

// RealPath and Mode are the file a write lands on, through whatever symlinks led there.
func TestReadFileRealPath(t *testing.T) {
	h := newWriteHome(t)
	real := h.file(h.at("proj/drop.txt"), "x", 0o644)
	link := h.link(real, h.at("proj/.env"))
	got, err := ReadFile(ReadRoots{Home: h.root}, "", link, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != link || got.RealPath != real || got.Mode != 0o644 {
		t.Errorf("got %s real %s mode %o", got.Path, got.RealPath, got.Mode)
	}
	dir := h.link(h.at("proj"), h.at("linked"))
	got, err = ReadFile(ReadRoots{Home: h.root}, "", dir+"/new.env", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.NotFound || got.RealPath != h.at("proj/new.env") || got.Mode != 0 {
		t.Errorf("missing: got %+v", got)
	}
	got, err = ReadFile(ReadRoots{Home: h.root}, "", h.at("nope/new.env"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.NotFound || got.RealPath != "" {
		t.Errorf("no directory: got %+v", got)
	}
}

// The temp folders are read as home is, by the spelling and the resolved path alike, and a
// file there says so; a link from them to anywhere else stays refused.
func TestReadFileTemp(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	at := func(p string) string { return filepath.Join(base, p) }
	file := func(p string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(at(p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(at(p), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	link := func(target, p string) {
		t.Helper()
		if err := os.Symlink(at(target), at(p)); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"home/notes.txt", "private/tmp/report.txt", "private/tmp/dir/deep.txt", "outside/secret"} {
		file(f)
	}
	link("private/tmp", "tmp") // /tmp is /private/tmp
	link("outside/secret", "private/tmp/out.txt")
	link("outside", "private/tmp/outdir")
	link("outside/gone", "private/tmp/dead.txt")
	link("home/notes.txt", "private/tmp/to-home.txt")
	link("private/tmp/report.txt", "home/to-temp.txt")
	roots := ReadRoots{Home: at("home"), Temp: []string{at("tmp"), at("private/tmp")}}

	tests := []struct {
		name        string
		roots       ReadRoots
		path        string
		wantReal    string
		notFound    bool
		isDir       bool
		outsideHome bool
		refused     bool
	}{
		{name: "as spelled", roots: roots, path: at("tmp/report.txt"), wantReal: at("private/tmp/report.txt"), outsideHome: true},
		{name: "resolved", roots: roots, path: at("private/tmp/report.txt"), wantReal: at("private/tmp/report.txt"), outsideHome: true},
		{name: "in a folder", roots: roots, path: at("tmp/dir/deep.txt"), wantReal: at("private/tmp/dir/deep.txt"), outsideHome: true},
		{name: "a folder", roots: roots, path: at("tmp/dir"), wantReal: at("private/tmp/dir"), isDir: true, outsideHome: true},
		{name: "missing, as spelled", roots: roots, path: at("tmp/nope.txt"), wantReal: at("private/tmp/nope.txt"), notFound: true, outsideHome: true},
		{name: "missing, resolved", roots: roots, path: at("private/tmp/nope.txt"), wantReal: at("private/tmp/nope.txt"), notFound: true, outsideHome: true},
		{name: "a dead link leading out", roots: roots, path: at("tmp/dead.txt"), wantReal: at("private/tmp/dead.txt"), notFound: true, outsideHome: true},
		{name: "a link leading out", roots: roots, path: at("tmp/out.txt"), refused: true},
		{name: "a linked folder leading out", roots: roots, path: at("tmp/outdir/secret"), refused: true},
		{name: "a link into home, reached through temp", roots: roots, path: at("tmp/to-home.txt"), wantReal: at("home/notes.txt"), outsideHome: true},
		{name: "a link from home into temp", roots: roots, path: at("home/to-temp.txt"), wantReal: at("private/tmp/report.txt"), outsideHome: true},
		{name: "home", roots: roots, path: at("home/notes.txt"), wantReal: at("home/notes.txt")},
		{name: "elsewhere", roots: roots, path: at("outside/secret"), refused: true},
		{name: "missing elsewhere", roots: roots, path: at("outside/nope"), refused: true},
		{name: "a system file", roots: roots, path: "/etc/hosts", refused: true},
		{name: "home alone reads no temp", roots: ReadRoots{Home: at("home")}, path: at("tmp/report.txt"), refused: true},
		{name: "home alone: missing", roots: ReadRoots{Home: at("home")}, path: at("tmp/nope.txt"), refused: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ReadFile(tt.roots, "", tt.path, 0)
			if tt.refused {
				if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "outside your home directory and the temp folders") {
					t.Fatalf("err = %v, want the refusal", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.RealPath != tt.wantReal || got.NotFound != tt.notFound || got.IsDir != tt.isDir || got.OutsideHome != tt.outsideHome {
				t.Errorf("got real %q notFound %t isDir %t outsideHome %t", got.RealPath, got.NotFound, got.IsDir, got.OutsideHome)
			}
		})
	}
}
