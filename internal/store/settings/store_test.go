package settings

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func openTest(t *testing.T, initial string) (*Store, *bus.Bus, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), FileName)
	if initial != "" {
		if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	b := bus.New()
	s, err := Open(context.Background(), Options{Path: path, Bus: b, Debounce: 20 * time.Millisecond, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, b, path
}

// waitFor receives from ch until ok returns true or 3s pass.
func waitFor(t *testing.T, ch <-chan *Snapshot, ok func(*Snapshot) bool) *Snapshot {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case s := <-ch:
			if ok(s) {
				return s
			}
		case <-deadline:
			t.Fatal("timed out waiting for a settings snapshot")
			return nil
		}
	}
}

func TestOpenCreatesDefaultsFile(t *testing.T) {
	s, _, path := openTest(t, "")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "# font_size = 13") {
		t.Fatalf("defaults file:\n%s", data)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
	snap := s.Snapshot()
	if snap.Revision != 1 || snap.Values[KeyFontSize] != "13" || snap.Path != path || len(snap.Issues) != 0 {
		t.Fatalf("snapshot = %+v", snap)
	}
}

func TestOpenReportsBadValues(t *testing.T) {
	s, _, _ := openTest(t, "[appearance]\nfont_size = 99\ntheme = \"dark\"\n[bogus]\nx = 1\n")
	snap := s.Snapshot()
	if snap.Settings.Appearance.FontSize != 13 || snap.Settings.Appearance.Theme != "dark" {
		t.Errorf("settings = %+v", snap.Settings.Appearance)
	}
	want := []Issue{{"appearance.font_size", "want 9 to 28, got 99"}, {"bogus.x", "unknown setting"}}
	if !slices.Equal(snap.Issues, want) {
		t.Errorf("issues = %v, want %v", snap.Issues, want)
	}
}

// A setting the app no longer has (threads.render, removed with terminal threads) is
// an issue, not an error: the file still loads.
func TestOpenReportsRemovedSettings(t *testing.T) {
	s, _, _ := openTest(t, "[threads]\nrender = \"terminal\"\ndefault_effort = \"low\"\n")
	snap := s.Snapshot()
	if snap.Settings.Threads.DefaultEffort != "low" {
		t.Errorf("settings = %+v", snap.Settings.Threads)
	}
	if want := []Issue{{"threads.render", "unknown setting"}}; !slices.Equal(snap.Issues, want) {
		t.Errorf("issues = %v, want %v", snap.Issues, want)
	}
}

func TestUpdate(t *testing.T) {
	s, b, path := openTest(t, "")
	s.SetCommands(testCmds)
	sub := bus.Subscribe[Changed](b, 8)
	defer sub.Close()
	var hooked []uint64
	s.OnChange(func(snap *Snapshot) { hooked = append(hooked, snap.Revision) })

	snap, err := s.Update(context.Background(), map[string]string{
		KeyFontSize: "16", KeyDefaultModel: "claude-opus-4-8[1m]", KeyNamingModel: "claude-4.5-haiku[1m]", KeybindingKey("project.refresh"): "cmd+alt+r",
	})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Settings.Appearance.FontSize != 16 || snap.Settings.Threads.DefaultModel != "claude-opus-4-8[1m]" ||
		snap.Settings.Threads.NamingModel != "claude-4.5-haiku[1m]" ||
		snap.Settings.Keybindings["project.refresh"] != "cmd+alt+r" {
		t.Fatalf("settings = %+v", snap.Settings)
	}
	data, _ := os.ReadFile(path)
	for _, want := range []string{"font_size = 16\n", "default_model = \"claude-opus-4-8[1m]\"\n", "naming_model = \"claude-4.5-haiku[1m]\"\n", `"project.refresh" = "cmd+alt+r"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("file lacks %q:\n%s", want, data)
		}
	}
	select {
	case ev := <-sub.C():
		if ev.Snapshot != snap {
			t.Errorf("published %d, returned %d", ev.Snapshot.Revision, snap.Revision)
		}
	case <-time.After(time.Second):
		t.Fatal("no Changed event")
	}
	if !slices.Equal(hooked, []uint64{snap.Revision - 1, snap.Revision}) {
		t.Errorf("hook saw revisions %v", hooked)
	}

	// Our own write is picked up by the watcher, but it changes nothing: no event.
	select {
	case ev := <-sub.C():
		t.Fatalf("unexpected event after own write: rev %d", ev.Snapshot.Revision)
	case <-time.After(200 * time.Millisecond):
	}

	// "" resets to the default.
	snap, err = s.Update(context.Background(), map[string]string{KeyFontSize: ""})
	if err != nil || snap.Values[KeyFontSize] != "13" {
		t.Fatalf("reset = %v, %v", snap.Values[KeyFontSize], err)
	}
	if data, _ := os.ReadFile(path); !strings.Contains(string(data), "# font_size = 13\n") {
		t.Errorf("reset key is not commented out:\n%s", data)
	}
}

// A settings file from before threads were renamed from sessions keeps its values, and
// the next Update writes them under the new names.
func TestLegacyFileRewrittenOnUpdate(t *testing.T) {
	s, _, path := openTest(t, "[sessions]\nauto_name = false\nscrollback_lines = 5000\n")
	if got := s.Snapshot().Settings.Threads; got.AutoName || got.ScrollbackLines != 5000 {
		t.Fatalf("legacy values not read: %+v", got)
	}
	if _, err := s.Update(context.Background(), map[string]string{KeyFontSize: "15"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "[sessions]") || !strings.Contains(text, "[threads]\n") || !strings.Contains(text, "\nauto_name = false\n") || !strings.Contains(text, "scrollback_lines = 5000\n") {
		t.Fatalf("file after Update:\n%s", text)
	}
}

func TestUpdateRejects(t *testing.T) {
	s, _, path := openTest(t, "")
	s.SetCommands(testCmds)
	before, _ := os.ReadFile(path)
	rev := s.Snapshot().Revision
	tests := []struct {
		name    string
		partial map[string]string
		want    []Issue
	}{
		{"bad int", map[string]string{KeyFontSize: "big", KeyTheme: "dark"}, []Issue{{KeyFontSize, `want an integer, got "big"`}}},
		{"unknown key", map[string]string{"threads.nope": "1"}, []Issue{{"threads.nope", "unknown setting"}}},
		{"reserved chord", map[string]string{KeybindingKey("thread.new"): "cmd+b"},
			[]Issue{{"keybindings.thread.new", "cmd+b is reserved by the app"}}},
		{"keybinding for an unknown command", map[string]string{KeybindingKey("x.y"): "cmd+j"}, []Issue{{"keybindings.x.y", "unknown setting"}}},
		{"collision", map[string]string{KeybindingKey("project.refresh"): "cmd+n"},
			[]Issue{{"keybindings.project.refresh", "cmd+n is already bound to thread.new"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := s.Update(context.Background(), tt.partial)
			var ve *ValidationError
			if !errors.As(err, &ve) || !slices.Equal(ve.Issues, tt.want) {
				t.Fatalf("err = %v, want issues %v", err, tt.want)
			}
			if after, _ := os.ReadFile(path); string(after) != string(before) {
				t.Fatal("a rejected update changed the file")
			}
			if s.Snapshot().Revision != rev {
				t.Fatalf("a rejected update published (rev %d)", s.Snapshot().Revision)
			}
		})
	}
}

func TestExternalEdits(t *testing.T) {
	s, _, path := openTest(t, "[appearance]\nfont_size = 14\n")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := s.Watch(ctx)
	if first := <-ch; first.Values[KeyFontSize] != "14" {
		t.Fatalf("first snapshot font size = %s", first.Values[KeyFontSize])
	}

	// A hand edit is picked up.
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 18\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, func(s *Snapshot) bool { return s.Values[KeyFontSize] == "18" })

	// A syntax error keeps the previous values and is reported; Update refuses to
	// overwrite the broken file.
	if err := os.WriteFile(path, []byte("[appearance\nfont_size = 20\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, ch, func(s *Snapshot) bool { return s.LoadError != "" })
	if snap.Values[KeyFontSize] != "18" {
		t.Errorf("font size after syntax error = %s, want the previous 18", snap.Values[KeyFontSize])
	}
	if _, err := s.Update(context.Background(), map[string]string{KeyTheme: "dark"}); !errors.Is(err, ErrFileInvalid) {
		t.Fatalf("update with a broken file: err = %v, want ErrFileInvalid", err)
	}

	// Fixing the file clears the error.
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 20\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, func(s *Snapshot) bool { return s.LoadError == "" && s.Values[KeyFontSize] == "20" })

	// Deleting the file means defaults.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, func(s *Snapshot) bool { return s.Values[KeyFontSize] == "13" })
}

func TestRestartPending(t *testing.T) {
	s, _, _ := openTest(t, "[threads]\nscrollback_lines = 5000\n")
	snap, err := s.Update(context.Background(), map[string]string{KeyScrollback: "20000", KeyFontSize: "15"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(snap.RestartPending, []string{KeyScrollback}) {
		t.Fatalf("restart pending = %v", snap.RestartPending)
	}
	snap, err = s.Update(context.Background(), map[string]string{KeyScrollback: "5000"})
	if err != nil || len(snap.RestartPending) != 0 {
		t.Fatalf("restart pending after revert = %v, %v", snap.RestartPending, err)
	}
}

func TestSetCommandsRevalidates(t *testing.T) {
	s, _, _ := openTest(t, "[keybindings]\n\"project.refresh\" = \"cmd+t\"\n\"gone.cmd\" = \"cmd+j\"\n")
	if got := s.Snapshot().Settings.Keybindings; got["project.refresh"] != "cmd+t" || got["gone.cmd"] != "cmd+j" {
		t.Fatalf("before SetCommands: %v", got)
	}
	if n := len(s.Fields()); n != len(staticFields) {
		t.Fatalf("fields before SetCommands = %d", n)
	}
	s.SetCommands(testCmds)
	snap := s.Snapshot()
	if len(snap.Settings.Keybindings) != 0 {
		t.Errorf("keybindings after SetCommands = %v, want both rejected", snap.Settings.Keybindings)
	}
	want := []Issue{
		{"keybindings.gone.cmd", `unknown command "gone.cmd"`},
		{"keybindings.project.refresh", "cmd+t is already bound to terminal.new"},
	}
	if !slices.Equal(snap.Issues, want) {
		t.Errorf("issues = %v, want %v", snap.Issues, want)
	}
	if n := len(s.Fields()); n != len(staticFields)+len(testCmds)-2 { // two NoKeybinding
		t.Errorf("fields after SetCommands = %d", n)
	}
}

// TestReloadNeverRevertsAnUpdate pins the ordering between the watcher's reload and
// Update: a reload that read the file before an Update wrote it must not publish its
// stale bytes after the Update returned. (It did once: reload read the file outside
// s.mu, so `settings set` followed by `settings get` could print the old value until
// the next fs event.) readFile pauses the reload right after its read; the Update runs
// in that gap if it can.
func TestReloadNeverRevertsAnUpdate(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte("[appearance]\nfont_size = 13\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The watcher never fires during the test; the test drives reload itself.
	s, err := Open(context.Background(), Options{Path: path, Debounce: time.Hour, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	read, proceed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	readFile = func(name string) ([]byte, error) {
		data, err := os.ReadFile(name)
		once.Do(func() { close(read); <-proceed })
		return data, err
	}
	t.Cleanup(func() { readFile = os.ReadFile })

	reloaded := make(chan struct{})
	go func() { defer close(reloaded); s.reload() }()
	<-read

	updated := make(chan error, 1)
	go func() {
		_, err := s.Update(context.Background(), map[string]string{KeyFontSize: "15"})
		updated <- err
	}()
	// With reload reading under s.mu the Update waits for the paused reload, so give it
	// a moment to run (when it can) and then let the reload finish either way.
	select {
	case err := <-updated:
		if err != nil {
			t.Fatal(err)
		}
		updated = nil
	case <-time.After(200 * time.Millisecond):
	}
	close(proceed)
	<-reloaded
	if updated != nil {
		if err := <-updated; err != nil {
			t.Fatal(err)
		}
	}
	if got := s.Snapshot().Values[KeyFontSize]; got != "15" {
		t.Fatalf("font size after Update returned and a concurrent reload finished = %s, want 15", got)
	}
}

// custom needs an image: Update refuses it with an empty appearance.backdrop_file or one
// naming no file in the backdrops directory, on whichever of the two keys it sets.
// Changes that leave both keys alone are not checked (a hand edit loads as it is).
func TestUpdateBackdropChoice(t *testing.T) {
	const img = "0123456789abcdef0123456789abcdef.png"
	tests := []struct {
		name    string
		initial string // the file before the update
		noDir   bool   // Options.BackdropsDir unset
		partial map[string]string
		want    []Issue // nil: accepted
	}{
		{name: "custom with no image", partial: map[string]string{KeyBackdrop: BackdropCustom},
			want: []Issue{{KeyBackdrop, "custom needs an image: add one under Settings › Appearance › Backdrop first"}}},
		{name: "custom with a missing image", partial: map[string]string{KeyBackdrop: BackdropCustom, KeyBackdropFile: "gone.png"},
			want: []Issue{{KeyBackdrop, `custom needs an image, and "gone.png" is not in the backdrops folder`}}},
		{name: "custom with an image", partial: map[string]string{KeyBackdrop: BackdropCustom, KeyBackdropFile: img}},
		{name: "custom keeping the remembered image", initial: "[appearance]\nbackdrop_file = \"" + img + "\"\n",
			partial: map[string]string{KeyBackdrop: BackdropCustom}},
		{name: "clearing the image under custom", initial: "[appearance]\nbackdrop = \"custom\"\nbackdrop_file = \"" + img + "\"\n",
			partial: map[string]string{KeyBackdropFile: ""},
			want:    []Issue{{KeyBackdropFile, "custom needs an image: add one under Settings › Appearance › Backdrop first"}}},
		{name: "a missing image under forest", partial: map[string]string{KeyBackdrop: BackdropForest, KeyBackdropFile: "gone.png"}},
		{name: "forest from a broken custom", initial: "[appearance]\nbackdrop = \"custom\"\n", partial: map[string]string{KeyBackdrop: BackdropForest}},
		{name: "another key under a broken custom", initial: "[appearance]\nbackdrop = \"custom\"\n", partial: map[string]string{KeyFontSize: "14"}},
		{name: "no directory: only an empty name is refused", noDir: true, partial: map[string]string{KeyBackdrop: BackdropCustom, KeyBackdropFile: "gone.png"}},
		{name: "no directory, no image", noDir: true, partial: map[string]string{KeyBackdrop: BackdropCustom},
			want: []Issue{{KeyBackdrop, "custom needs an image: add one under Settings › Appearance › Backdrop first"}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(home, FileName)
			if tt.initial != "" {
				if err := os.WriteFile(path, []byte(tt.initial), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			opts := Options{Path: path, Log: slog.New(slog.DiscardHandler)}
			if !tt.noDir {
				opts.BackdropsDir = filepath.Join(home, "backdrops")
				if err := os.Mkdir(opts.BackdropsDir, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(opts.BackdropsDir, img), []byte("png"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			s, err := Open(context.Background(), opts)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = s.Close() })
			_, err = s.Update(context.Background(), tt.partial)
			if tt.want == nil {
				if err != nil {
					t.Fatalf("Update: %v", err)
				}
				return
			}
			var ve *ValidationError
			if !errors.As(err, &ve) || !slices.Equal(ve.Issues, tt.want) {
				t.Fatalf("err = %v, want issues %v", err, tt.want)
			}
		})
	}
}
