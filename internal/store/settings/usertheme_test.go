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

// userSet is the catalog plus two user themes, and two that went away.
func userSet() theme.Set {
	gone := map[string]string{"old-copy": "nord", "orphan": ""}
	return theme.NewSet([]theme.Theme{
		{ID: "ocean-dusk", Name: "Ocean Dusk", Scheme: theme.SchemeDark, From: "catppuccin-mocha"},
		{ID: "paper", Name: "Paper", Scheme: theme.SchemeLight},
	}, gone)
}

func TestThemeSlotsWithUserThemes(t *testing.T) {
	fields := fieldsFor(userSet())
	var dark, light Field
	for _, f := range fields {
		switch f.Key {
		case KeyThemeDark:
			dark = f
		case KeyThemeLight:
			light = f
		}
	}
	if dark.Enum[0] != "ocean-dusk" || dark.EnumLabels[0] != "Ocean Dusk" || dark.Enum[1] != theme.Default(theme.SchemeDark) || slices.Contains(dark.Enum, "paper") {
		t.Errorf("dark enum = %v / %v", dark.Enum, dark.EnumLabels)
	}
	if light.Enum[0] != "paper" || len(light.Enum) != len(theme.IDs(theme.SchemeLight))+1 {
		t.Errorf("light enum = %v", light.Enum)
	}
	// The static list (and so the file's comments) keeps the catalog only.
	if f := field(t, KeyThemeDark); slices.Contains(f.Enum, "ocean-dusk") {
		t.Error("staticFields changed")
	}

	tests := []struct {
		name      string
		raw       string
		wantValue string
		wantIssue string // substring; "" = none
	}{
		{"a user theme", "ocean-dusk", "ocean-dusk", ""},
		{"a curated theme", "nord", "nord", ""},
		{"a user theme of the other scheme", "paper", "github-dark", `Paper ("paper") is a light theme`},
		{"gone, with a from", "old-copy", "nord", `theme "old-copy" is gone: its file in the themes directory was deleted or no longer reads; showing Nord ("nord"), the theme it was copied from`},
		{"gone, without one", "orphan", "github-dark", `theme "orphan" is gone`},
		{"never a theme", "sepia", "github-dark", `unknown theme "sepia"; dark themes are "ocean-dusk", "github-dark"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := resolveThemes(map[string]string{KeyThemeDark: tt.raw}, nil, userSet())
			if got := r.settings.Appearance.ThemeDark; got != tt.wantValue || r.values[KeyThemeDark] != tt.wantValue {
				t.Errorf("value = %q, want %q", got, tt.wantValue)
			}
			if tt.wantIssue == "" {
				if len(r.issues) != 0 {
					t.Errorf("issues = %v", r.issues)
				}
				return
			}
			if len(r.issues) != 1 || !strings.Contains(r.issues[0].Message, tt.wantIssue) {
				t.Errorf("issues = %v, want %q", r.issues, tt.wantIssue)
			}
			// The file keeps what it says, as for any rejected value.
			if keep, _ := r.fileValues(map[string]string{KeyThemeDark: tt.raw}); keep[KeyThemeDark] != tt.raw {
				t.Errorf("file keeps %q", keep[KeyThemeDark])
			}
		})
	}
}

// The store follows the user themes: Open with them, Update accepts them, and a theme
// that goes away while selected shows its from, with one issue and one log line.
func TestStoreSetThemes(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(path, []byte("[appearance]\ntheme_dark = \"ocean-dusk\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	s, err := Open(context.Background(), Options{Path: path, Debounce: 20 * time.Millisecond, Log: slog.New(slog.NewTextHandler(&logs, nil)), Themes: userSet()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if snap := s.Snapshot(); snap.Settings.Appearance.ThemeDark != "ocean-dusk" || len(snap.Issues) != 0 || logs.Len() != 0 {
		t.Fatalf("at Open: %+v, issues %v, logs %s", snap.Settings.Appearance, snap.Issues, logs.String())
	}
	if f := s.Fields(); !slices.ContainsFunc(f, func(f Field) bool { return f.Key == KeyThemeLight && slices.Contains(f.Enum, "paper") }) {
		t.Error("Fields lacks the user theme")
	}
	if _, err := s.Update(context.Background(), map[string]string{KeyThemeLight: "paper"}); err != nil {
		t.Fatalf("Update(paper) = %v", err)
	}
	var ve *ValidationError
	if _, err := s.Update(context.Background(), map[string]string{KeyThemeLight: "ocean-dusk"}); !errors.As(err, &ve) {
		t.Fatalf("Update(ocean-dusk as light) = %v", err)
	}

	// ocean-dusk is deleted.
	rev := s.Snapshot().Revision
	gone := theme.NewSet([]theme.Theme{{ID: "paper", Name: "Paper", Scheme: theme.SchemeLight}}, map[string]string{"ocean-dusk": "catppuccin-mocha"})
	s.SetThemes(gone)
	snap := s.Snapshot()
	if snap.Revision != rev+1 || snap.Settings.Appearance.ThemeDark != "catppuccin-mocha" || snap.Values[KeyThemeDark] != "catppuccin-mocha" {
		t.Fatalf("after the delete: rev %d, %+v", snap.Revision, snap.Settings.Appearance)
	}
	if len(snap.Issues) != 1 || snap.Issues[0].Key != KeyThemeDark || !strings.Contains(snap.Issues[0].Message, "the theme it was copied from") {
		t.Errorf("issues = %v", snap.Issues)
	}
	s.SetThemes(gone) // again: no new log line, no new snapshot
	if n := strings.Count(logs.String(), "key="+KeyThemeDark); n != 1 || s.Snapshot().Revision != snap.Revision {
		t.Errorf("logged %d times, rev %d:\n%s", n, s.Snapshot().Revision, logs.String())
	}
	if b, _ := os.ReadFile(path); !strings.Contains(string(b), "theme_dark = \"ocean-dusk\"") {
		t.Errorf("the file lost the value:\n%s", b)
	}
	// It comes back: selected again, no issue.
	s.SetThemes(userSet())
	if snap := s.Snapshot(); snap.Settings.Appearance.ThemeDark != "ocean-dusk" || len(snap.Issues) != 0 {
		t.Errorf("back: %+v, %v", snap.Settings.Appearance, snap.Issues)
	}
}
