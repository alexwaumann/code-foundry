package settings

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

func TestUpdate(t *testing.T) {
	s, b, path := openTest(t, "")
	s.SetCommands(testCmds)
	sub := bus.Subscribe[Changed](b, 8)
	defer sub.Close()
	var hooked []uint64
	s.OnChange(func(snap *Snapshot) { hooked = append(hooked, snap.Revision) })

	snap, err := s.Update(context.Background(), map[string]string{
		KeyFontSize: "16", KeyDefaultModel: "opus", KeybindingKey("repo.refresh"): "cmd+alt+r",
	})
	if err != nil {
		t.Fatal(err)
	}
	if snap.Settings.Appearance.FontSize != 16 || snap.Settings.Sessions.DefaultModel != "opus" ||
		snap.Settings.Keybindings["repo.refresh"] != "cmd+alt+r" {
		t.Fatalf("settings = %+v", snap.Settings)
	}
	data, _ := os.ReadFile(path)
	for _, want := range []string{"font_size = 16\n", "default_model = \"opus\"\n", `"repo.refresh" = "cmd+alt+r"`} {
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
		{"unknown key", map[string]string{"sessions.nope": "1"}, []Issue{{"sessions.nope", "unknown setting"}}},
		{"reserved chord", map[string]string{KeybindingKey("session.new"): "cmd+b"},
			[]Issue{{"keybindings.session.new", "cmd+b is reserved by the app"}}},
		{"keybinding for an unknown command", map[string]string{KeybindingKey("x.y"): "cmd+j"}, []Issue{{"keybindings.x.y", "unknown setting"}}},
		{"collision", map[string]string{KeybindingKey("repo.refresh"): "cmd+n"},
			[]Issue{{"keybindings.repo.refresh", "cmd+n is already bound to session.new"}}},
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
	s, _, _ := openTest(t, "[sessions]\nscrollback_lines = 5000\n")
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
	s, _, _ := openTest(t, "[keybindings]\n\"repo.refresh\" = \"cmd+t\"\n\"gone.cmd\" = \"cmd+j\"\n")
	if got := s.Snapshot().Settings.Keybindings; got["repo.refresh"] != "cmd+t" || got["gone.cmd"] != "cmd+j" {
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
		{"keybindings.repo.refresh", "cmd+t is already bound to terminal.new"},
	}
	if !slices.Equal(snap.Issues, want) {
		t.Errorf("issues = %v, want %v", snap.Issues, want)
	}
	if n := len(s.Fields()); n != len(staticFields)+len(testCmds) {
		t.Errorf("fields after SetCommands = %d", n)
	}
}
