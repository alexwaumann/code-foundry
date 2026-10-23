package usertheme

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// userFile is a valid user theme: GitHub Dark's colours under id, copied from from.
func userFile(t *testing.T, id, name, from string) theme.File {
	t.Helper()
	f, ok := theme.Curated("github-dark")
	if !ok {
		t.Fatal("no github-dark")
	}
	f.ID, f.Name, f.Pair, f.From = id, name, "", from
	return f
}

func write(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "themes")
	return New(Options{Dir: dir, Log: slog.New(slog.DiscardHandler), WatchRetry: 20 * time.Millisecond}), dir
}

func ids(fs []theme.File) []string {
	out := make([]string, len(fs))
	for i, f := range fs {
		out[i] = f.ID
	}
	return out
}

func TestRead(t *testing.T) {
	valid := func(id, name string) string { return string(userFile(t, id, name, "github-dark").Marshal()) }
	tests := []struct {
		name       string
		files      map[string]string
		wantIDs    []string
		wantIssues []string // "file: substring"
	}{
		{name: "no directory"},
		{name: "two themes, by name", files: map[string]string{"zeta.json": valid("zeta", "Alpha"), "alpha.json": valid("alpha", "Zeta")}, wantIDs: []string{"zeta", "alpha"}},
		{name: "other files are ignored", files: map[string]string{"notes.md": "x", ".ocean.json.123": "{", "ocean.json": valid("ocean", "Ocean")}, wantIDs: []string{"ocean"}},
		{name: "upper-case extension", files: map[string]string{"ocean.JSON": valid("ocean", "Ocean")}, wantIDs: []string{"ocean"}},
		{name: "not JSON", files: map[string]string{"bad.json": "{"}, wantIssues: []string{"bad.json: not JSON"}},
		{name: "invalid colour", files: map[string]string{"bad.json": strings.Replace(valid("bad", "Bad"), `"canvas": "#04070c"`, `"canvas": "#0407"`, 1)}, wantIssues: []string{`bad.json: base.canvas: "#0407" is not #rrggbb`}},
		{name: "id does not match the file name", files: map[string]string{"ocean.json": valid("sea", "Sea")}, wantIssues: []string{`ocean.json: its id "sea" does not match the file name; name the file sea.json`}},
		{name: "a curated id", files: map[string]string{"nord.json": valid("nord", "My Nord")}, wantIssues: []string{`nord.json: "nord" is a curated theme's id`}},
		{name: "valid and invalid side by side", files: map[string]string{"a.json": valid("a", "A"), "b.json": "[]"}, wantIDs: []string{"a"}, wantIssues: []string{"b.json: want a JSON object"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, dir := newStore(t)
			for name, data := range tt.files {
				write(t, filepath.Join(dir, name), data)
			}
			if tt.files != nil {
				if err := os.Mkdir(filepath.Join(dir, "sub.json"), 0o700); err != nil { // a directory: skipped
					t.Fatal(err)
				}
			}
			snap := s.Load()
			if got := ids(snap.Themes); !slices.Equal(got, tt.wantIDs) && !(len(got) == 0 && len(tt.wantIDs) == 0) {
				t.Errorf("themes = %v, want %v", got, tt.wantIDs)
			}
			if len(snap.Issues) != len(tt.wantIssues) {
				t.Fatalf("issues = %+v, want %v", snap.Issues, tt.wantIssues)
			}
			for i, w := range tt.wantIssues {
				file, msg, _ := strings.Cut(w, ": ")
				if snap.Issues[i].File != file || !strings.Contains(snap.Issues[i].Message, msg) {
					t.Errorf("issue %d = %+v, want %s", i, snap.Issues[i], w)
				}
			}
			// A file that does not read is never touched.
			for name, data := range tt.files {
				if b, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(b) != data {
					t.Errorf("%s changed: %v", name, err)
				}
			}
		})
	}
}

func TestSaveDuplicateDelete(t *testing.T) {
	s, dir := newStore(t)
	b := bus.New()
	s.opts.Bus = b
	sub := bus.Subscribe[Changed](b, 16)
	defer sub.Close()
	var hooked []uint64
	s.OnChange(func(snap *Snapshot) { hooked = append(hooked, snap.Version) })
	s.Load()

	// Save: new, then the same id again.
	f := userFile(t, "ocean-dusk", "Ocean Dusk", "catppuccin-mocha")
	f.Base.Accent = "#5FB3B3"
	got, err := s.Save(f)
	if err != nil || got.Replaced || got.Path != filepath.Join(dir, "ocean-dusk.json") || got.File.Base.Accent != "#5fb3b3" {
		t.Fatalf("Save = %+v, %v", got, err)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v, %v", fi, err)
	}
	if b, _ := os.ReadFile(got.Path); string(b) != string(got.File.Marshal()) {
		t.Errorf("file = %s", b)
	}
	if !s.Snapshot().Set().Valid("ocean-dusk", theme.SchemeDark) {
		t.Error("the set does not have the saved theme")
	}
	f.Name = "Ocean Dusk 2"
	if got, err := s.Save(f); err != nil || !got.Replaced {
		t.Fatalf("Save again = %+v, %v", got, err)
	}
	if n := s.Snapshot().Themes[0].Name; n != "Ocean Dusk 2" {
		t.Errorf("name = %q", n)
	}

	// Save refuses a curated id and an invalid file.
	if _, err := s.Save(userFile(t, "nord", "Nord", "")); !errors.Is(err, ErrCurated) {
		t.Errorf("Save(nord) = %v", err)
	}
	bad := userFile(t, "bad", "Bad", "")
	bad.Base.Terminal.ANSI = bad.Base.Terminal.ANSI[:3]
	if _, err := s.Save(bad); !errors.Is(err, theme.ErrInvalid) {
		t.Errorf("Save(bad) = %v", err)
	}

	// Duplicate: a curated theme, then again (numbered), a user theme, a given name.
	dups := []struct {
		id, name, by       string
		wantID, wantName   string
		wantFrom, wantPair string
	}{
		{"gruvbox-dark", "", "", "gruvbox-dark-copy", "Gruvbox Dark copy", "gruvbox-dark", "gruvbox-light"},
		{"gruvbox-dark", "", "s-1", "gruvbox-dark-copy-2", "Gruvbox Dark copy 2", "gruvbox-dark", "gruvbox-light"},
		{"ocean-dusk", "  Tide pool ", "", "ocean-dusk-copy", "Tide pool", "ocean-dusk", ""},
	}
	for _, d := range dups {
		got, err := s.Duplicate(d.id, d.name, d.by)
		if err != nil {
			t.Fatalf("Duplicate(%s): %v", d.id, err)
		}
		if g := got.File; g.ID != d.wantID || g.Name != d.wantName || g.From != d.wantFrom || g.Pair != d.wantPair || g.CreatedBy != d.by || got.Replaced {
			t.Errorf("Duplicate(%s) = %+v", d.id, g.Theme())
		}
	}
	if src, _ := theme.Curated("gruvbox-dark"); s.Snapshot().Themes[0].Base.Terminal.ANSI[0] != src.Base.Terminal.ANSI[0] {
		t.Error("the copy's colours are not the original's")
	}
	if _, err := s.Duplicate("sepia", "", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("Duplicate(sepia) = %v", err)
	}

	// Delete: the user theme goes and is remembered as gone, with its from.
	del, err := s.Delete("ocean-dusk")
	if err != nil || del.From != "catppuccin-mocha" {
		t.Fatalf("Delete = %+v, %v", del, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "ocean-dusk.json")); !os.IsNotExist(err) {
		t.Errorf("file still there: %v", err)
	}
	set := s.Snapshot().Set()
	if set.Valid("ocean-dusk", theme.SchemeDark) || set.Fallback("ocean-dusk", theme.SchemeDark) != "catppuccin-mocha" {
		t.Errorf("after delete: gone = %v", set.Gone())
	}
	// Its copy now falls back through it.
	if _, err := s.Delete("ocean-dusk-copy"); err != nil {
		t.Fatal(err)
	}
	if fb := s.Snapshot().Set().Fallback("ocean-dusk-copy", theme.SchemeDark); fb != "catppuccin-mocha" {
		t.Errorf("chain fallback = %q", fb)
	}
	if _, err := s.Delete("nord"); !errors.Is(err, ErrCurated) {
		t.Errorf("Delete(nord) = %v", err)
	}
	if _, err := s.Delete("ocean-dusk"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Delete again = %v", err)
	}

	// Every change ran the hook once and was published once, in order.
	want := []uint64{0}
	for v := uint64(1); v <= s.Snapshot().Version; v++ {
		want = append(want, v)
	}
	if !slices.Equal(hooked, want) {
		t.Errorf("hooks saw %v, want %v", hooked, want)
	}
	var published []uint64
	for len(sub.C()) > 0 {
		published = append(published, (<-sub.C()).Snapshot.Version)
	}
	if !slices.Equal(published, want[1:]) {
		t.Errorf("published %v, want %v", published, want[1:])
	}
	// A read that finds nothing new publishes nothing.
	v := s.Snapshot().Version
	if s.Load(); s.Snapshot().Version != v || len(sub.C()) != 0 {
		t.Error("an unchanged read published")
	}
}

// A setting naming a theme whose file no longer validates falls back to its from, also
// when the daemon never saw it valid (its header still names it).
func TestInvalidFileCountsAsGone(t *testing.T) {
	s, dir := newStore(t)
	data := strings.Replace(string(userFile(t, "warm", "Warm", "gruvbox-dark").Marshal()), `"accent": "#4493f8"`, `"accent": "nope"`, 1)
	write(t, filepath.Join(dir, "warm.json"), data)
	set := s.Load().Set()
	if set.Valid("warm", theme.SchemeDark) || set.Fallback("warm", theme.SchemeDark) != "gruvbox-dark" {
		t.Errorf("gone = %v", set.Gone())
	}
	// Fixed by hand: valid again, not gone.
	write(t, filepath.Join(dir, "warm.json"), string(userFile(t, "warm", "Warm", "gruvbox-dark").Marshal()))
	if set := s.Load().Set(); !set.Valid("warm", theme.SchemeDark) || len(set.Gone()) != 0 {
		t.Errorf("after the fix: gone = %v", set.Gone())
	}
}

// A file written before a slot was retired still loads, without the pin; it is not
// rewritten, and saving it leaves the pin out.
func TestRetiredSlotPinIsDropped(t *testing.T) {
	s, dir := newStore(t)
	f := userFile(t, "warm", "Warm", "github-dark")
	f.Overrides = map[string]string{"--cf-icon": "#112233", "--cf-accent": "#5fb3b3"}
	data := string(f.Marshal())
	write(t, filepath.Join(dir, "warm.json"), data)
	snap := s.Load()
	if len(snap.Issues) != 0 || len(snap.Themes) != 1 {
		t.Fatalf("themes %v, issues %+v", ids(snap.Themes), snap.Issues)
	}
	if got := snap.Themes[0].Overrides; len(got) != 1 || got["--cf-accent"] != "#5fb3b3" {
		t.Errorf("overrides = %v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "warm.json")); string(b) != data {
		t.Error("the file was rewritten by a read")
	}
	if _, err := s.Save(snap.Themes[0]); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "warm.json")); strings.Contains(string(b), "--cf-icon") {
		t.Errorf("saved with the retired pin:\n%s", b)
	}
	// A save that names it is refused.
	f.ID = "warm-2"
	if _, err := s.Save(f); !errors.Is(err, theme.ErrInvalid) || !strings.Contains(err.Error(), "was removed") {
		t.Errorf("save with --cf-icon: %v", err)
	}
}

func TestWatch(t *testing.T) {
	s, dir := newStore(t)
	b := bus.New()
	s.opts.Bus = b
	sub := bus.Subscribe[Changed](b, 16)
	defer sub.Close()
	s.Watch(t.Context())
	wait := func(want ...string) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			select {
			case ev := <-sub.C():
				if got := ids(ev.Snapshot.Themes); slices.Equal(got, want) || (len(got) == 0 && len(want) == 0) {
					return
				}
			case <-deadline:
				t.Fatalf("no snapshot with %v", want)
			}
		}
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(dir, "a.json"), string(userFile(t, "a", "A", "").Marshal()))
	wait("a")
	write(t, filepath.Join(dir, "b.json"), string(userFile(t, "b", "B", "").Marshal()))
	wait("a", "b")
	if err := os.Remove(filepath.Join(dir, "a.json")); err != nil {
		t.Fatal(err)
	}
	wait("b")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	wait()
}
