package usertheme

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

// Every replaced or removed version is kept (newest MaxHistory), Restore puts one back
// byte for byte, and Delete takes the versions with the theme.
func TestHistory(t *testing.T) {
	s, dir := newStore(t)
	f := userFile(t, "ocean", "Ocean", "github-dark")
	v1, err := s.Save(f)
	if err != nil || v1.PreviousVersion != "" {
		t.Fatalf("first save = %+v, %v", v1, err)
	}
	f.Base.Accent = "#5fb3b3"
	v2, err := s.Save(f)
	if err != nil || v2.PreviousVersion != v1.File.Version() {
		t.Fatalf("second save = %+v, %v; want previous %s", v2, err, v1.File.Version())
	}
	if h := s.Snapshot().History["ocean"]; !slices.Equal(h, []string{v1.File.Version()}) {
		t.Errorf("history = %v", h)
	}
	// The same file again: no new version, and no previous.
	if again, err := s.Save(f); err != nil || again.PreviousVersion != "" {
		t.Errorf("same save = %+v, %v", again, err)
	}

	// Restore: the first version, exactly; the second is kept in turn.
	r, err := s.Restore("ocean", v1.File.Version())
	if err != nil || r.PreviousVersion != v2.File.Version() {
		t.Fatalf("Restore = %+v, %v", r, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "ocean.json")); string(b) != string(v1.File.Marshal()) {
		t.Errorf("restored file:\n%s", b)
	}
	snap := s.Snapshot()
	if !snap.HasVersion("ocean", v1.File.Version()) || !snap.HasVersion("ocean", v2.File.Version()) || snap.HasVersion("ocean", strings.Repeat("0", 32)) {
		t.Errorf("HasVersion: history %v", snap.History)
	}
	for _, tt := range []struct{ id, version string }{{"ocean", strings.Repeat("0", 32)}, {"ocean", "../x"}, {"nope", v1.File.Version()}} {
		if _, err := s.Restore(tt.id, tt.version); !errors.Is(err, ErrNotFound) {
			t.Errorf("Restore(%s, %s) = %v", tt.id, tt.version, err)
		}
	}

	// A hand edit keeps the version it replaced too.
	before := s.Snapshot().Themes[0]
	g := before.Clone()
	g.Base.Accent = "#ff0000"
	write(t, filepath.Join(dir, "ocean.json"), string(g.Marshal()))
	if snap := s.Load(); !slices.Contains(snap.History["ocean"], before.Version()) || snap.History["ocean"][0] != before.Version() {
		t.Errorf("after a hand edit: history %v, want %s first", snap.History["ocean"], before.Version())
	}

	// At most MaxHistory are kept.
	for i := range MaxHistory + 3 {
		f.Base.Accent = fmt.Sprintf("#0000%02x", i)
		if _, err := s.Save(f); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(s.Snapshot().History["ocean"]); n != MaxHistory {
		t.Errorf("%d versions kept, want %d", n, MaxHistory)
	}

	// A file removed by hand: its last version is kept (Restore brings it back).
	last := s.Snapshot().Themes[0]
	if err := os.Remove(filepath.Join(dir, "ocean.json")); err != nil {
		t.Fatal(err)
	}
	if snap := s.Load(); len(snap.Themes) != 0 || snap.History["ocean"][0] != last.Version() {
		t.Fatalf("after removing by hand: %v", snap.History["ocean"])
	}
	if _, err := s.Restore("ocean", last.Version()); err != nil || len(s.Snapshot().Themes) != 1 {
		t.Fatalf("restore after a hand removal: %v", err)
	}

	// Delete takes the versions with it.
	if _, err := s.Delete("ocean"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, HistoryDir, "ocean")); !os.IsNotExist(err) || len(s.Snapshot().History) != 0 {
		t.Errorf("versions left after delete: %v, %v", err, s.Snapshot().History)
	}
}

// The ids the store has seen survive a restart: a theme removed while the app was closed,
// or a copy of a deleted theme, falls back along its from as it did before.
func TestSeenSurvivesARestart(t *testing.T) {
	s, dir := newStore(t)
	parent := userFile(t, "ocean", "Ocean", "catppuccin-mocha")
	child := userFile(t, "ocean-child", "Ocean Child", "ocean")
	for _, f := range []theme.File{parent, child} {
		if _, err := s.Save(f); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Delete("ocean"); err != nil {
		t.Fatal(err)
	}
	// The daemon stops; the child's file is removed by hand while it is down.
	if err := os.Remove(filepath.Join(dir, "ocean-child.json")); err != nil {
		t.Fatal(err)
	}
	again := New(Options{Dir: dir, Log: slog.New(slog.DiscardHandler)})
	set := again.Load().Set()
	for _, tt := range []struct{ id, want string }{{"ocean", "catppuccin-mocha"}, {"ocean-child", "catppuccin-mocha"}} {
		if got := set.Fallback(tt.id, theme.SchemeDark); got != tt.want {
			t.Errorf("after a restart, Fallback(%s) = %q, want %q", tt.id, got, tt.want)
		}
	}
	// A broken index is a fresh one.
	write(t, filepath.Join(dir, SeenFile), "{")
	if set := New(Options{Dir: dir, Log: slog.New(slog.DiscardHandler)}).Load().Set(); set.Fallback("ocean", theme.SchemeDark) != "" {
		t.Error("a broken index still gave a fallback")
	}
}

// Where a save writes: <id>.json, a file named in another case renamed to it, a symlink
// written through (the link stays, and so does the target's mode).
func TestSaveTarget(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, dir, other string)
		check func(t *testing.T, dir, other string, saved Saved, err error)
	}{
		{name: "a file named in another case", setup: func(t *testing.T, dir, _ string) {
			write(t, filepath.Join(dir, "Ocean.json"), string(userFile(t, "ocean", "Ocean", "").Marshal()))
		}, check: func(t *testing.T, dir, _ string, saved Saved, err error) {
			names := dirNames(t, dir)
			if err != nil || !saved.Replaced || !slices.Equal(names, []string{"ocean.json"}) {
				t.Errorf("save = %+v, %v; dir %v", saved, err, names)
			}
		}},
		{name: "a symlink", setup: func(t *testing.T, dir, other string) {
			target := filepath.Join(other, "ocean.json")
			write(t, target, string(userFile(t, "ocean", "Ocean", "").Marshal()))
			if err := os.Chmod(target, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, filepath.Join(dir, "ocean.json")); err != nil {
				t.Fatal(err)
			}
		}, check: func(t *testing.T, dir, other string, saved Saved, err error) {
			target := filepath.Join(other, "ocean.json")
			fi, lerr := os.Lstat(filepath.Join(dir, "ocean.json"))
			b, _ := os.ReadFile(target)
			tfi, _ := os.Stat(target)
			if err != nil || lerr != nil || fi.Mode()&os.ModeSymlink == 0 || !strings.Contains(string(b), "Ocean, saved") || tfi.Mode().Perm() != 0o644 {
				t.Errorf("save = %+v, %v; link %v; target %s", saved, err, fi, b)
			}
		}},
		{name: "a dangling symlink", setup: func(t *testing.T, dir, other string) {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(other, "gone.json"), filepath.Join(dir, "ocean.json")); err != nil {
				t.Fatal(err)
			}
		}, check: func(t *testing.T, _, _ string, _ Saved, err error) {
			if err == nil || !strings.Contains(err.Error(), "a link to a file that is not there") {
				t.Errorf("err = %v", err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, dir := newStore(t)
			other := t.TempDir()
			tt.setup(t, dir, other)
			s.Load()
			saved, err := s.Save(userFile(t, "ocean", "Ocean, saved", ""))
			tt.check(t, dir, other, saved, err)
		})
	}
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	return out
}

// DeleteFile removes a file that did not load, by its name or by the id of its name.
func TestDeleteFile(t *testing.T) {
	tests := []struct {
		name, file, arg string
		wantErr         error
	}{
		{name: "by name", file: "ocean copy.json", arg: "ocean copy.json"},
		{name: "by the id of its name", file: "broken.json", arg: "broken"},
		{name: "by an id, another case", file: "Broken.json", arg: "broken"},
		{name: "not an issue", file: "broken.json", arg: "other.json", wantErr: ErrNotFound},
		{name: "a valid theme is not an issue", file: "broken.json", arg: "ocean", wantErr: ErrNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, dir := newStore(t)
			write(t, filepath.Join(dir, "ocean.json"), string(userFile(t, "ocean", "Ocean", "").Marshal()))
			write(t, filepath.Join(dir, tt.file), "{")
			s.Load()
			is, err := s.DeleteFile(tt.arg)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil || is.File != tt.file || len(s.Snapshot().Issues) != 0 || !slices.Equal(dirNames(t, dir), []string{"ocean.json"}) {
				t.Errorf("DeleteFile = %+v, %v; dir %v", is, err, dirNames(t, dir))
			}
		})
	}
}

// Past MaxFiles the files of the themes in use are read first, and the rest say why.
func TestInUseReadPastTheCap(t *testing.T) {
	s, dir := newStore(t)
	s.opts.InUse = func() []string { return []string{"zz-in-use"} }
	for i := range MaxFiles {
		id := fmt.Sprintf("t%03d", i)
		write(t, filepath.Join(dir, id+Ext), string(userFile(t, id, id, "").Marshal()))
	}
	write(t, filepath.Join(dir, "zz-in-use.json"), string(userFile(t, "zz-in-use", "In use", "").Marshal()))
	snap := s.Load()
	if _, ok := snap.Get("zz-in-use"); !ok || len(snap.Themes) != MaxFiles {
		t.Fatalf("in-use theme not read: %d themes", len(snap.Themes))
	}
	if len(snap.Issues) != 1 || snap.Issues[0].File != "t499.json" || !strings.Contains(snap.Issues[0].Message, "over the 500-file limit") {
		t.Errorf("issues = %+v", snap.Issues)
	}
}
