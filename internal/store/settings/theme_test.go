package settings

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/theme"
)

func TestThemeSlotFields(t *testing.T) {
	tests := []struct {
		key, scheme, def string
	}{
		{KeyThemeDark, theme.SchemeDark, "github-dark"},
		{KeyThemeLight, theme.SchemeLight, "github-light"},
	}
	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			f := field(t, tt.key)
			if f.Group != GroupAppearance || f.Type != Enum || f.Default != tt.def {
				t.Fatalf("field = %+v", f)
			}
			if !slices.Equal(f.Enum, theme.IDs(tt.scheme)) || !slices.Equal(f.EnumLabels, theme.Names(tt.scheme)) {
				t.Errorf("enum = %v / %v, want the catalog's %s themes", f.Enum, f.EnumLabels, tt.scheme)
			}
		})
	}
	// Scheme, then the two slots, at the top of Appearance.
	var order []string
	for _, f := range staticFields {
		if f.Group == GroupAppearance {
			order = append(order, f.Key)
		}
	}
	if want := []string{KeyTheme, KeyThemeDark, KeyThemeLight}; !slices.Equal(order[:3], want) {
		t.Errorf("appearance order = %v, want %v first", order, want)
	}
	if d := Defaults().Appearance; d.Theme != "system" || d.ThemeDark != "github-dark" || d.ThemeLight != "github-light" {
		t.Errorf("defaults = %+v", d)
	}
}

// A file written before the theme slots existed loads with the default themes,
// keeps its scheme, reports nothing, and renders the new keys commented out. No rewrite
// is needed: settings.toml has no schema version, a missing key is its default.
func TestOlderFileGetsThemeDefaults(t *testing.T) {
	old := "[appearance]\ntheme = \"light\"\nfont_size = 14\n"
	raw, err := decode([]byte(old))
	if err != nil {
		t.Fatal(err)
	}
	r := resolve(raw, nil)
	if len(r.issues) != 0 {
		t.Errorf("issues = %v", r.issues)
	}
	a := r.settings.Appearance
	if a.Theme != "light" || a.FontSize != 14 || a.ThemeDark != "github-dark" || a.ThemeLight != "github-light" {
		t.Errorf("appearance = %+v", a)
	}
	text := string(render(r.accepted, nil))
	for _, want := range []string{"theme = \"light\"\n", "# theme_dark = \"github-dark\"\n", "# theme_light = \"github-light\"\n"} {
		if !strings.Contains(text, want) {
			t.Errorf("rendered file lacks %q", want)
		}
	}
}

// A theme id on disk the catalog does not have (removed in a later release) or of the
// wrong scheme falls back to the default at read time. The file is left as it is, and
// Open logs each once.
func TestThemeOnDiskFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	initial := "[appearance]\ntheme = \"dark\"\ntheme_dark = \"retired-theme\"\ntheme_light = \"dracula\"\n"
	if err := os.WriteFile(path, []byte(initial), 0o600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	s, err := Open(context.Background(), Options{Path: path, Debounce: 20 * time.Millisecond, Log: slog.New(slog.NewTextHandler(&logs, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	snap := s.Snapshot()
	if a := snap.Settings.Appearance; a.Theme != "dark" || a.ThemeDark != "github-dark" || a.ThemeLight != "github-light" {
		t.Errorf("appearance = %+v", a)
	}
	if snap.Values[KeyThemeDark] != "github-dark" || snap.Values[KeyThemeLight] != "github-light" {
		t.Errorf("values = %q, %q", snap.Values[KeyThemeDark], snap.Values[KeyThemeLight])
	}
	keys := make([]string, len(snap.Issues))
	for i, is := range snap.Issues {
		keys[i] = is.Key
	}
	if !slices.Equal(keys, []string{KeyThemeDark, KeyThemeLight}) ||
		!strings.Contains(snap.Issues[0].Message, `unknown theme "retired-theme"`) ||
		!strings.Contains(snap.Issues[1].Message, "is a dark theme") {
		t.Errorf("issues = %v", snap.Issues)
	}
	if got, _ := os.ReadFile(path); string(got) != initial {
		t.Errorf("file rewritten:\n%s", got)
	}
	for _, k := range []string{KeyThemeDark, KeyThemeLight} {
		if n := strings.Count(logs.String(), "key="+k); n != 1 {
			t.Errorf("%s logged %d times:\n%s", k, n, logs.String())
		}
	}
	// The CLI's daemon-less read agrees.
	if a := Read(path).Appearance; a.ThemeDark != "github-dark" || a.ThemeLight != "github-light" {
		t.Errorf("Read = %+v", a)
	}
}

func TestUpdateThemeSlots(t *testing.T) {
	s, _, path := openTest(t, "")
	snap, err := s.Update(context.Background(), map[string]string{KeyThemeDark: "dracula", KeyThemeLight: "rose-pine-dawn"})
	if err != nil {
		t.Fatal(err)
	}
	if a := snap.Settings.Appearance; a.ThemeDark != "dracula" || a.ThemeLight != "rose-pine-dawn" {
		t.Errorf("appearance = %+v", a)
	}
	before, _ := os.ReadFile(path)
	if !strings.Contains(string(before), "theme_dark = \"dracula\"\n") || !strings.Contains(string(before), "theme_light = \"rose-pine-dawn\"\n") {
		t.Errorf("file:\n%s", before)
	}
	tests := []struct {
		key, value, want string
	}{
		{KeyThemeDark, "catppuccin-latte", "is a light theme; the dark theme must be one of"},
		{KeyThemeLight, "nord", "is a dark theme; the light theme must be one of"},
		{KeyThemeDark, "no-such-theme", `unknown theme "no-such-theme"`},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			_, err := s.Update(context.Background(), map[string]string{tt.key: tt.value})
			var ve *ValidationError
			if !errors.As(err, &ve) || len(ve.Issues) != 1 || ve.Issues[0].Key != tt.key || !strings.Contains(ve.Issues[0].Message, tt.want) {
				t.Fatalf("err = %v, want %s: ...%s", err, tt.key, tt.want)
			}
			if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
				t.Error("a rejected update changed the file")
			}
		})
	}
	// "" resets to the default.
	snap, err = s.Update(context.Background(), map[string]string{KeyThemeDark: ""})
	if err != nil || snap.Settings.Appearance.ThemeDark != "github-dark" {
		t.Fatalf("reset = %+v, %v", snap.Settings.Appearance, err)
	}
}
