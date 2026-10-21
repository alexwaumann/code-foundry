package settings

import (
	"context"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// A save from the app or the CLI keeps every hand-written value it cannot use (a value
// that fails validation, an unknown key, a keybinding for a command that is not
// registered now), marked with why, so it survives until the user fixes it.
func TestUpdateKeepsValuesWithIssues(t *testing.T) {
	tests := []struct {
		name     string
		file     string
		cmds     bool // SetCommands(testCmds) before the save
		wantText []string
		wantRaw  map[string]string // after the save, decoded from the file
		dropped  []string          // keys the save cannot keep
	}{
		{
			name:     "unknown model id",
			file:     "[threads]\ndefault_model = \"claude-opus-4-6[1m]\"  # work laptop\n",
			wantText: []string{"# Ignored: ", "default_model = \"claude-opus-4-6[1m]\"\n"},
			wantRaw:  map[string]string{KeyDefaultModel: "claude-opus-4-6[1m]"},
		},
		{
			name:     "int out of range",
			file:     "[appearance]\nfont_size = 30000\n",
			wantText: []string{"# Ignored: want 9 to 28, got 30000.\nfont_size = 30000\n"},
			wantRaw:  map[string]string{KeyFontSize: "30000"},
		},
		{
			name:     "not an int",
			file:     "[appearance]\nfont_size = \"big\"\n",
			wantText: []string{"font_size = \"big\"\n"},
			wantRaw:  map[string]string{KeyFontSize: "big"},
		},
		{
			name:     "unknown key in a known table",
			file:     "[threads]\nfuture_flag = true\ncount = 7\nlabel = \"007\"\n",
			wantText: []string{"# Ignored: unknown setting.\nfuture_flag = true\n", "count = 7\n", "label = \"007\"\n"},
			wantRaw:  map[string]string{"threads.future_flag": "true", "threads.count": "7", "threads.label": "007"},
		},
		{
			name:     "unknown table",
			file:     "[later]\n\"a.b\" = \"x\"\nc = 1\n",
			wantText: []string{"\n[later]\n", "\"a.b\" = \"x\"\n", "c = 1\n"},
			wantRaw:  map[string]string{"later.a.b": "x", "later.c": "1"},
		},
		{
			name:     "top-level key",
			file:     "loose = \"yes\"\n",
			wantText: []string{"loose = \"yes\"\n"},
			wantRaw:  map[string]string{"loose": "yes"},
		},
		{
			name:    "top-level key named like a table is dropped",
			file:    "threads = 5\n",
			wantRaw: map[string]string{},
			dropped: []string{"threads"},
		},
		{
			name:     "keybinding for a command not registered now",
			file:     "[keybindings]\n\"plugin.minimal.hello\" = \"cmd+shift+y\"\n",
			cmds:     true,
			wantText: []string{"# Ignored: unknown command \"plugin.minimal.hello\".\n\"plugin.minimal.hello\" = \"cmd+shift+y\"\n"},
			wantRaw:  map[string]string{KeybindingKey("plugin.minimal.hello"): "cmd+shift+y"},
		},
		{
			name:     "colliding keybinding",
			file:     "[keybindings]\n\"project.refresh\" = \"cmd+t\"\n",
			cmds:     true,
			wantText: []string{"\"project.refresh\" = \"cmd+t\"\n"},
			wantRaw:  map[string]string{KeybindingKey("project.refresh"): "cmd+t"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, path := openTest(t, tt.file)
			if tt.cmds {
				s.SetCommands(testCmds)
			}
			before := s.Snapshot().Issues
			snap, err := s.Update(context.Background(), map[string]string{KeyZoom: "110"})
			if err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(path)
			for _, w := range tt.wantText {
				if !strings.Contains(string(data), w) {
					t.Errorf("file lacks %q:\n%s", w, data)
				}
			}
			raw, err := decode(data)
			if err != nil {
				t.Fatalf("saved file does not parse: %v\n%s", err, data)
			}
			delete(raw, KeyZoom)
			if !maps.Equal(raw, tt.wantRaw) {
				t.Errorf("file holds %v, want %v", raw, tt.wantRaw)
			}
			// The issues are the same before and after: the save neither fixed nor lost them.
			want := slices.DeleteFunc(slices.Clone(before), func(is Issue) bool { return slices.Contains(tt.dropped, is.Key) })
			if !slices.Equal(snap.Issues, want) {
				t.Errorf("issues after save = %v, want %v", snap.Issues, want)
			}
			// A second save rewrites the same bytes.
			if _, err := s.Update(context.Background(), map[string]string{KeyZoom: "120"}); err != nil {
				t.Fatal(err)
			}
			again, _ := os.ReadFile(path)
			if got := strings.Replace(string(again), "zoom = 120", "zoom = 110", 1); got != string(data) {
				t.Errorf("second save changed the file:\n%s\nwant\n%s", again, data)
			}
		})
	}
}

// Resetting or fixing a key with an issue removes the kept raw value.
func TestUpdateFixesKeptValue(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  string // the key's line in the file
	}{
		{"reset", "", "# font_size = 13\n"},
		{"fix", "15", "\nfont_size = 15\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s, _, path := openTest(t, "[appearance]\nfont_size = 30000\n")
			snap, err := s.Update(context.Background(), map[string]string{KeyFontSize: tt.value})
			if err != nil {
				t.Fatal(err)
			}
			data, _ := os.ReadFile(path)
			if !strings.Contains(string(data), tt.want) || strings.Contains(string(data), "30000") || len(snap.Issues) != 0 {
				t.Fatalf("issues %v, file:\n%s", snap.Issues, data)
			}
		})
	}
}

// A file that does not parse at Open falls back to the last one that did.
func TestOpenFallsBackToLastGood(t *testing.T) {
	tests := []struct {
		name     string
		lastGood bool // a copy exists from an earlier successful load
		wantSize string
	}{
		{"last good copy", true, "17"},
		{"no copy: defaults", false, "13"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, FileName)
			open := func() *Store {
				s, err := Open(context.Background(), Options{Path: path, Debounce: time.Hour, Log: slog.New(slog.DiscardHandler)})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = s.Close() })
				return s
			}
			if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 17\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			_ = open().Close()
			if !tt.lastGood {
				if err := os.Remove(path + LastGoodSuffix); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 18\n[appearance]\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			s := open()
			snap := s.Snapshot()
			if snap.LoadError == "" || snap.Values[KeyFontSize] != tt.wantSize {
				t.Fatalf("load error %q, font size %s; want an error and %s", snap.LoadError, snap.Values[KeyFontSize], tt.wantSize)
			}
			// The broken file never becomes the copy.
			if b, err := os.ReadFile(path + LastGoodSuffix); tt.lastGood && !strings.Contains(string(b), "font_size = 17") {
				t.Fatalf("copy = %q, %v", b, err)
			}
		})
	}
}

// A symlinked settings file (a dotfiles repo) stays a link: saves write its target, and
// edits made to the target are picked up.
func TestSymlinkedFile(t *testing.T) {
	home, dots := t.TempDir(), t.TempDir()
	target := filepath.Join(dots, "code-foundry.toml")
	if err := os.WriteFile(target, []byte("[appearance]\nfont_size = 14\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, FileName)
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	s, err := Open(context.Background(), Options{Path: path, Debounce: 20 * time.Millisecond, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := s.Watch(ctx)

	if _, err := s.Update(context.Background(), map[string]string{KeyZoom: "110"}); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(path); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("settings file is no longer a symlink: %v, %v", fi.Mode(), err)
	}
	data, _ := os.ReadFile(target)
	if !strings.Contains(string(data), "zoom = 110") || !strings.Contains(string(data), "font_size = 14") {
		t.Fatalf("target after save:\n%s", data)
	}
	if fi, _ := os.Stat(target); fi.Mode().Perm() != 0o644 {
		t.Errorf("target mode = %v, want its 0644 kept", fi.Mode().Perm())
	}
	if names := dirNames(t, dots); !slices.Equal(names, []string{"code-foundry.toml"}) {
		t.Errorf("dotfiles dir holds %v", names)
	}

	if err := os.WriteFile(target, []byte("[appearance]\nfont_size = 19\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, func(s *Snapshot) bool { return s.Values[KeyFontSize] == "19" })
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func TestResolveLink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.toml")
	if err := os.WriteFile(real, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := func(name, to string) string {
		p := filepath.Join(dir, name)
		if err := os.Symlink(to, p); err != nil {
			t.Fatal(err)
		}
		return p
	}
	abs := link("abs", real)
	rel := link("rel", "real.toml")
	chain := link("chain", "abs")
	dangling := link("dangling", "missing.toml")
	loopA := filepath.Join(dir, "loopA")
	link("loopB", loopA)
	link("loopA", filepath.Join(dir, "loopB"))
	tests := []struct{ in, want string }{
		{real, real},
		{abs, real},
		{rel, real},
		{chain, real},
		{dangling, filepath.Join(dir, "missing.toml")},
		{filepath.Join(dir, "absent"), filepath.Join(dir, "absent")},
		{loopA, loopA},
	}
	for _, tt := range tests {
		if got := resolveLink(tt.in); got != tt.want {
			t.Errorf("resolveLink(%s) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

// Commands that register after the store opened (plugins) get their keybindings: a
// SetCommands that adds the command accepts the override the file kept.
func TestSetCommandsLaterAcceptsKeptKeybinding(t *testing.T) {
	s, _, path := openTest(t, "[keybindings]\n\"plugin.minimal.hello\" = \"cmd+shift+y\"\n")
	s.SetCommands(testCmds)
	if _, err := s.Update(context.Background(), map[string]string{KeyZoom: "110"}); err != nil {
		t.Fatal(err)
	}
	s.SetCommands(append(slices.Clone(testCmds), CommandInfo{Name: "plugin.minimal.hello", Title: "Hello", Category: "Minimal"}))
	snap := s.Snapshot()
	if snap.Settings.Keybindings["plugin.minimal.hello"] != "cmd+shift+y" || len(snap.Issues) != 0 {
		t.Fatalf("keybindings %v, issues %v", snap.Settings.Keybindings, snap.Issues)
	}
	if _, err := s.Update(context.Background(), map[string]string{KeybindingKey("plugin.minimal.hello"): "cmd+shift+u"}); err != nil {
		t.Fatalf("set the plugin command's keybinding: %v", err)
	}
	if data, _ := os.ReadFile(path); !strings.Contains(string(data), "\"plugin.minimal.hello\" = \"cmd+shift+u\"\n") || strings.Contains(string(data), "# Ignored: unknown command") {
		t.Fatalf("file:\n%s", data)
	}
}
