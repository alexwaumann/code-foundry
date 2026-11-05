package fsx

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// writeHome is a home directory and a folder outside it, with the Writer under test.
type writeHome struct {
	t             *testing.T
	root, outside string
	w             *Writer
}

func newWriteHome(t *testing.T) *writeHome {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &writeHome{t: t, root: filepath.Join(base, "home"), outside: filepath.Join(base, "outside")}
	for _, d := range []string{filepath.Join(h.root, "proj"), h.outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	h.w = &Writer{Root: h.root}
	return h
}

// at is rel under home.
func (h *writeHome) at(rel string) string { return filepath.Join(h.root, rel) }

// file writes a file, with its mode set exactly (no umask), and returns its path.
func (h *writeHome) file(p, contents string, mode fs.FileMode) string {
	h.t.Helper()
	if err := os.WriteFile(p, []byte(contents), mode); err != nil {
		h.t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		h.t.Fatal(err)
	}
	return p
}

func (h *writeHome) link(target, link string) string {
	h.t.Helper()
	if err := os.Symlink(target, link); err != nil {
		h.t.Fatal(err)
	}
	return link
}

// saw is a request for the file at p as a read sees it now, for an absolute path.
func (h *writeHome) saw(p string) WriteRequest {
	h.t.Helper()
	f, err := ReadFile(h.root, "", p, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	return WriteRequest{Path: p, ModifiedAt: f.ModifiedAt.UnixMilli(), Size: f.Size}
}

func (h *writeHome) contents(p string) string {
	h.t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		h.t.Fatal(err)
	}
	return string(b)
}

func (h *writeHome) mode(p string) fs.FileMode {
	h.t.Helper()
	fi, err := os.Stat(p)
	if err != nil {
		h.t.Fatal(err)
	}
	return fi.Mode().Perm()
}

// temps lists every temp file left under home.
func (h *writeHome) temps() []string {
	h.t.Helper()
	var out []string
	if err := filepath.WalkDir(filepath.Dir(h.root), func(p string, _ fs.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(filepath.Base(p), ".cf-write-") {
			out = append(out, p)
		}
		return err
	}); err != nil {
		h.t.Fatal(err)
	}
	return out
}

const newContents = "new contents\n"

func TestWrite(t *testing.T) {
	type outcome int
	const (
		written outcome = iota
		conflicted
		gone // conflicted, with NotFound
		invalid
	)
	tests := []struct {
		name string
		// arrange builds the file system and the request, and says where the contents
		// land (written) or what must stay as it is (any other outcome; "" for nothing).
		arrange func(h *writeHome) (req WriteRequest, target string)
		want    outcome
		mode    fs.FileMode // the file's mode afterwards, when set
		check   func(t *testing.T, h *writeHome)
	}{
		{name: "edit of an unchanged file", want: written, mode: 0o644,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return h.saw(p), p
			}},
		{name: "conflict by modification time", want: conflicted,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				r := h.saw(p)
				r.ModifiedAt--
				return r, p
			}},
		{name: "conflict by size", want: conflicted,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				r := h.saw(p)
				r.Size++
				return r, p
			}},
		{name: "no baseline is a conflict", want: conflicted,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return WriteRequest{Path: p}, p
			}},
		{name: "force overwrites a changed file", want: written, mode: 0o640,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o640)
				return WriteRequest{Path: p, Force: true}, p
			}},
		{name: "a vanished file is a conflict", want: gone,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				r := h.saw(p)
				if err := os.Remove(p); err != nil {
					h.t.Fatal(err)
				}
				return r, ""
			},
			check: func(t *testing.T, h *writeHome) {
				if _, err := os.Lstat(h.at("proj/a.txt")); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("a vanished file came back: %v", err)
				}
			}},
		{name: "force writes a vanished file anew", want: written, mode: 0o600,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/a.txt"), Force: true}, h.at("proj/a.txt")
			}},
		{name: "a vanished directory is a conflict", want: gone,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/gone/a.txt"), ModifiedAt: 5, Size: 5}, ""
			}},
		{name: "force needs the directory", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/gone/a.txt"), Force: true}, ""
			}},
		{name: "create", want: written, mode: 0o600,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/new.txt"), Create: true}, h.at("proj/new.txt")
			}},
		{name: "create in a linked directory", want: written, mode: 0o600,
			arrange: func(h *writeHome) (WriteRequest, string) {
				h.link(h.at("proj"), h.at("alias"))
				return WriteRequest{Path: h.at("alias/new.txt"), Create: true}, h.at("proj/new.txt")
			}},
		{name: "create over an existing file is a conflict", want: conflicted,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return WriteRequest{Path: p, Create: true}, p
			}},
		{name: "create needs the directory", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/gone/new.txt"), Create: true}, ""
			}},
		{name: "create below a file", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return WriteRequest{Path: filepath.Join(p, "new.txt"), Create: true}, p
			}},
		{name: "create and force together", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/new.txt"), Create: true, Force: true}, ""
			}},
		{name: "a missing file is not created without the flag", want: gone,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/new.txt")}, ""
			},
			check: func(t *testing.T, h *writeHome) {
				if _, err := os.Lstat(h.at("proj/new.txt")); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("created without the flag: %v", err)
				}
			}},
		{name: "mode 0600 stays", want: written, mode: 0o600,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/id_rsa"), "old", 0o600)
				return h.saw(p), p
			}},
		{name: "mode 0644 stays", want: written, mode: 0o644,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return h.saw(p), p
			}},
		{name: "mode 0755 stays", want: written, mode: 0o755,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/run.sh"), "old", 0o755)
				return h.saw(p), p
			}},
		{name: "a symlink is written through", want: written, mode: 0o600,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o600)
				r := h.saw(p)
				r.Path = h.link("a.txt", h.at("proj/link"))
				return r, p
			},
			check: func(t *testing.T, h *writeHome) {
				fi, err := os.Lstat(h.at("proj/link"))
				if err != nil || fi.Mode()&fs.ModeSymlink == 0 {
					t.Errorf("the link is gone: %v, %v", fi, err)
				}
			}},
		{name: "force writes through a symlink", want: written,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				return WriteRequest{Path: h.link(p, h.at("link")), Force: true}, p
			},
			check: func(t *testing.T, h *writeHome) {
				if fi, err := os.Lstat(h.at("link")); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
					t.Errorf("the link is gone: %v, %v", fi, err)
				}
			}},
		{name: "a symlink out of home is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(filepath.Join(h.outside, "secret"), "old", 0o644)
				return WriteRequest{Path: h.link(p, h.at("proj/escape")), Force: true}, p
			}},
		{name: "a linked directory out of home is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: filepath.Join(h.link(h.outside, h.at("out")), "new.txt"), Create: true}, ""
			},
			check: func(t *testing.T, h *writeHome) {
				if _, err := os.Lstat(filepath.Join(h.outside, "new.txt")); !errors.Is(err, fs.ErrNotExist) {
					t.Errorf("wrote outside home: %v", err)
				}
			}},
		{name: "a path outside home is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(filepath.Join(h.outside, "secret"), "old", 0o644)
				return WriteRequest{Path: p, Force: true}, p
			}},
		{name: "a new path outside home is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: filepath.Join(h.outside, "gone", "new.txt")}, ""
			}},
		{name: "a symlink leading nowhere is a vanished file", want: gone,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.link(h.at("nothing"), h.at("proj/dead"))}, ""
			}},
		{name: "create refuses a symlink leading nowhere", want: gone,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.link(h.at("nothing"), h.at("proj/dead")), Create: true}, ""
			},
			check: func(t *testing.T, h *writeHome) {
				if fi, err := os.Lstat(h.at("proj/dead")); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
					t.Errorf("the link is gone: %v, %v", fi, err)
				}
			}},
		{name: "force never replaces a symlink leading nowhere", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.link(filepath.Join(h.outside, "nothing"), h.at("proj/dead")), Force: true}, ""
			},
			check: func(t *testing.T, h *writeHome) {
				if fi, err := os.Lstat(h.at("proj/dead")); err != nil || fi.Mode()&fs.ModeSymlink == 0 {
					t.Errorf("the link is gone: %v, %v", fi, err)
				}
			}},
		{name: "a directory is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj"), Force: true}, ""
			}},
		{name: "create over a directory is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj"), Create: true}, ""
			}},
		{name: "a FIFO is refused", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				if err := syscall.Mkfifo(h.at("proj/pipe"), 0o644); err != nil {
					h.t.Fatal(err)
				}
				return WriteRequest{Path: h.at("proj/pipe"), Force: true}, ""
			}},
		{name: "protected by its own name", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/guarded.txt"), "old", 0o644)
				return WriteRequest{Path: p, Force: true}, p
			}},
		{name: "protected where a symlink leads", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/guarded.txt"), "old", 0o644)
				return WriteRequest{Path: h.link(p, h.at("link")), Force: true}, p
			}},
		{name: "a new file protected by its name", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: h.at("proj/guarded.txt"), Create: true}, ""
			}},
		{name: "relative to base_dir", want: written,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				r := h.saw(p)
				r.BaseDir, r.Path = h.at("proj"), "a.txt"
				return r, p
			}},
		{name: "tilde", want: written,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at("proj/a.txt"), "old", 0o644)
				r := h.saw(p)
				r.Path = "~/proj/a.txt"
				return r, p
			}},
		{name: "relative without base_dir", want: invalid,
			arrange: func(h *writeHome) (WriteRequest, string) {
				return WriteRequest{Path: "a.txt", Create: true}, ""
			}},
		{name: "a name at the filesystem's limit", want: written,
			arrange: func(h *writeHome) (WriteRequest, string) {
				p := h.file(h.at(strings.Repeat("n", 255)), "old", 0o644)
				return h.saw(p), p
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			h.w.Protected = func(p string) bool { return filepath.Base(p) == "guarded.txt" }
			req, target := tt.arrange(h)
			req.Contents = []byte(newContents)
			before := ""
			if target != "" && tt.want != written {
				before = h.contents(target)
			}
			got, err := h.w.Write(req)

			if tt.want == invalid {
				if !errors.Is(err, ErrInvalidArgument) {
					t.Fatalf("err = %v, want ErrInvalidArgument", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if got.Conflict != (tt.want == conflicted || tt.want == gone) || got.NotFound != (tt.want == gone) {
				t.Errorf("Conflict %t, NotFound %t", got.Conflict, got.NotFound)
			}
			switch {
			case tt.want == written:
				if s := h.contents(target); s != newContents {
					t.Errorf("file holds %q", s)
				}
				// The baseline moved: the next read is not a conflict.
				r := h.saw(target)
				if got.ModifiedAt != r.ModifiedAt || got.Size != r.Size {
					t.Errorf("result %d/%d, a read sees %d/%d", got.ModifiedAt, got.Size, r.ModifiedAt, r.Size)
				}
			case target != "":
				if s := h.contents(target); s != before {
					t.Errorf("file changed to %q", s)
				}
			}
			if tt.want == conflicted {
				r := h.saw(target)
				if got.ModifiedAt != r.ModifiedAt || got.Size != r.Size {
					t.Errorf("conflict says %d/%d, the file is %d/%d", got.ModifiedAt, got.Size, r.ModifiedAt, r.Size)
				}
			}
			if tt.mode != 0 {
				if m := h.mode(target); m != tt.mode {
					t.Errorf("mode = %o, want %o", m, tt.mode)
				}
			}
			if tt.check != nil {
				tt.check(t, h)
			}
			if err != nil && strings.Contains(err.Error(), newContents) {
				t.Errorf("the error holds the contents: %v", err)
			}
			if left := h.temps(); len(left) != 0 {
				t.Errorf("temp files left: %v", left)
			}
		})
	}
}

func TestWriteCap(t *testing.T) {
	tests := []struct {
		name string
		size int
		ok   bool
	}{
		{"nothing", 0, true},
		{"at the cap", MaxWriteBytes, true},
		{"one over", MaxWriteBytes + 1, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			p := h.file(h.at("proj/a.txt"), "old", 0o644)
			r := h.saw(p)
			r.Contents = bytes.Repeat([]byte("s"), tt.size)
			_, err := h.w.Write(r)
			if tt.ok {
				if err != nil {
					t.Fatal(err)
				}
				if n := len(h.contents(p)); n != tt.size {
					t.Errorf("file is %d bytes", n)
				}
				return
			}
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("err = %v, want ErrInvalidArgument", err)
			}
			if strings.Contains(err.Error(), "sss") {
				t.Errorf("the error holds the contents: %v", err)
			}
			if s := h.contents(p); s != "old" {
				t.Errorf("file changed to %d bytes", len(s))
			}
		})
	}
}

// Another process gets in between the first check and the write.
func TestWriteRaces(t *testing.T) {
	tests := []struct {
		name string
		req  func(h *writeHome, p string) WriteRequest
		// race changes the target at p once the temp file is complete.
		race         func(h *writeHome, p string)
		wantConflict bool
		wantNotFound bool
		wantError    bool
		want         string // what p holds afterwards, "" for nothing to read
	}{
		{name: "the file changed", wantConflict: true, want: "theirs!",
			req:  func(h *writeHome, p string) WriteRequest { return h.saw(h.file(p, "old", 0o644)) },
			race: func(h *writeHome, p string) { h.file(p, "theirs!", 0o644) }},
		{name: "the file vanished", wantConflict: true, wantNotFound: true,
			req: func(h *writeHome, p string) WriteRequest { return h.saw(h.file(p, "old", 0o644)) },
			race: func(h *writeHome, p string) {
				if err := os.Remove(p); err != nil {
					h.t.Fatal(err)
				}
			}},
		{name: "a symlink took the file's place", wantConflict: true, wantNotFound: true,
			req: func(h *writeHome, p string) WriteRequest { return h.saw(h.file(p, "old", 0o644)) },
			race: func(h *writeHome, p string) {
				if err := os.Remove(p); err != nil {
					h.t.Fatal(err)
				}
				h.link(h.at("elsewhere"), p)
			}},
		{name: "create finds a file there", wantConflict: true, want: "theirs!",
			req:  func(_ *writeHome, p string) WriteRequest { return WriteRequest{Path: p, Create: true} },
			race: func(h *writeHome, p string) { h.file(p, "theirs!", 0o644) }},
		{name: "force on a vanished file finds one there", wantConflict: true, want: "theirs!",
			req:  func(_ *writeHome, p string) WriteRequest { return WriteRequest{Path: p, Force: true} },
			race: func(h *writeHome, p string) { h.file(p, "theirs!", 0o644) }},
		{name: "force, and the rename fails", wantError: true,
			req: func(h *writeHome, p string) WriteRequest {
				h.file(p, "old", 0o644)
				return WriteRequest{Path: p, Force: true}
			},
			race: func(h *writeHome, p string) {
				if err := os.Remove(p); err != nil {
					h.t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Join(p, "x"), 0o755); err != nil {
					h.t.Fatal(err)
				}
			}},
		{name: "create, and the link fails", wantError: true,
			req: func(_ *writeHome, p string) WriteRequest { return WriteRequest{Path: p, Create: true} },
			race: func(h *writeHome, p string) {
				if err := os.RemoveAll(filepath.Dir(p)); err != nil {
					h.t.Fatal(err)
				}
			}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newWriteHome(t)
			p := h.at("proj/a.txt")
			req := tt.req(h, p)
			req.Contents = []byte(newContents)
			h.w.staged = func() { tt.race(h, p) }
			got, err := h.w.Write(req)
			if (err != nil) != tt.wantError {
				t.Fatalf("err = %v, want one: %t", err, tt.wantError)
			}
			if got.Conflict != tt.wantConflict || got.NotFound != tt.wantNotFound {
				t.Errorf("Conflict %t, NotFound %t", got.Conflict, got.NotFound)
			}
			if tt.want != "" {
				if s := h.contents(p); s != tt.want {
					t.Errorf("file holds %q", s)
				}
				if got.Size != int64(len(tt.want)) {
					t.Errorf("Size = %d, want the file now there", got.Size)
				}
			}
			if left := h.temps(); len(left) != 0 {
				t.Errorf("temp files left: %v", left)
			}
		})
	}
}

// The temp file is complete, and no more open than the file it replaces, before the
// target is touched.
func TestWriteStagedFile(t *testing.T) {
	for _, mode := range []fs.FileMode{0o600, 0o644, 0o400} {
		h := newWriteHome(t)
		p := h.file(h.at("proj/a.txt"), "old", mode)
		req := h.saw(p)
		req.Contents = []byte(newContents)
		h.w.staged = func() {
			temps := h.temps()
			if len(temps) != 1 || filepath.Dir(temps[0]) != filepath.Dir(p) {
				t.Fatalf("temp files: %v", temps)
			}
			if m := h.mode(temps[0]); m != mode {
				t.Errorf("temp mode = %o, want %o", m, mode)
			}
			if s := h.contents(p); s != "old" {
				t.Errorf("target already holds %q", s)
			}
		}
		if _, err := h.w.Write(req); err != nil {
			t.Fatal(err)
		}
		if m := h.mode(p); m != mode {
			t.Errorf("mode = %o, want %o", m, mode)
		}
	}
}

// Of two writes from one baseline, one wins and the other finds its file.
func TestWriteConcurrent(t *testing.T) {
	h := newWriteHome(t)
	p := h.file(h.at("proj/a.txt"), "old", 0o644)
	base := h.saw(p)
	const writers = 8
	results := make([]WriteResult, writers)
	var wg sync.WaitGroup
	for i := range writers {
		wg.Go(func() {
			req := base
			req.Contents = []byte(strings.Repeat("x", i+10)) // sizes differ from the baseline's
			res, err := h.w.Write(req)
			if err != nil {
				t.Error(err)
			}
			results[i] = res
		})
	}
	wg.Wait()
	won := 0
	for _, r := range results {
		if !r.Conflict {
			won++
		}
	}
	if won != 1 {
		t.Errorf("%d writes won, want 1", won)
	}
}

// A directory the file modes keep closed is a plain failure: no TCC advice, nothing left.
func TestWriteUnwritableDirectory(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes anywhere")
	}
	h := newWriteHome(t)
	p := h.file(h.at("proj/a.txt"), "old", 0o644)
	req := h.saw(p)
	req.Contents = []byte(newContents)
	if err := os.Chmod(filepath.Dir(p), 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Dir(p), 0o755) })
	_, err := h.w.Write(req)
	if err == nil || errors.Is(err, ErrNotPermitted) || !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("err = %v, want a plain permission error", err)
	}
	if strings.Contains(err.Error(), newContents) {
		t.Errorf("the error holds the contents: %v", err)
	}
	if s := h.contents(p); s != "old" {
		t.Errorf("file changed to %q", s)
	}
	if left := h.temps(); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
}

func TestWriteFailed(t *testing.T) {
	w := &Writer{Root: "/Users/me"}
	const p = "/Users/me/Documents/a.md"
	tests := []struct {
		name    string
		err     error
		privacy bool
	}{
		{"macOS refused", &fs.PathError{Op: "open", Path: p, Err: syscall.EPERM}, true},
		{"file modes", &fs.PathError{Op: "open", Path: p, Err: syscall.EACCES}, false},
		{"a link refused", &os.LinkError{Op: "link", Old: p + ".t", New: p, Err: syscall.EPERM}, true},
		{"disk full", &fs.PathError{Op: "write", Path: p, Err: syscall.ENOSPC}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := w.failed(p, p, tt.err)
			if errors.Is(err, ErrNotPermitted) != tt.privacy {
				t.Fatalf("err = %v, want privacy %t", err, tt.privacy)
			}
			if tt.privacy && !strings.Contains(err.Error(), "blocked writing "+p) {
				t.Errorf("not worded for writing: %v", err)
			}
			if !errors.Is(err, tt.err) {
				t.Errorf("err = %v does not wrap the cause", err)
			}
		})
	}
}

// The result is the next edit's baseline.
func TestWriteMovesTheBaseline(t *testing.T) {
	h := newWriteHome(t)
	p := h.file(h.at("proj/a.txt"), "old", 0o644)
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatal(err)
	}
	req := h.saw(p)
	req.Contents = []byte(newContents)
	got, err := h.w.Write(req)
	if err != nil {
		t.Fatal(err)
	}
	if got.ModifiedAt <= old.UnixMilli() || got.Size != int64(len(newContents)) {
		t.Errorf("result %d/%d, the old file was %d", got.ModifiedAt, got.Size, old.UnixMilli())
	}
	again, err := h.w.Write(WriteRequest{Path: p, Contents: []byte("second"), ModifiedAt: got.ModifiedAt, Size: got.Size})
	if err != nil || again.Conflict {
		t.Fatalf("second edit: %+v, %v", again, err)
	}
}
