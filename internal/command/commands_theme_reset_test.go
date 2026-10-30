package command_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
)

func TestThemeReset(t *testing.T) {
	tests := []struct {
		name string
		// setup runs first, each a command and its args.
		setup   [][2]any
		showing string // the scheme the window published; "" for none
		args    map[string]string
		wantMsg string
		wantKey string // the setting reset
		wantErr string
	}{
		{name: "dark slot", setup: [][2]any{{"theme.set-dark", map[string]string{"theme": "dracula"}}},
			args: map[string]string{"slot": "dark"}, wantKey: "appearance.theme_dark",
			wantMsg: "dark theme = GitHub Dark (github-dark), the default, was Dracula (dracula); the scheme is system (the Mac's appearance decides), so it shows while the Mac is dark"},
		{name: "a slot on its default already", args: map[string]string{"slot": "light"}, showing: "light", wantKey: "appearance.theme_light",
			wantMsg: "light theme = GitHub Light (github-light), the default"},
		{name: "no slot: the scheme set", showing: "dark", wantKey: "appearance.theme_light",
			setup:   [][2]any{{"theme.set-light", map[string]string{"theme": "rose-pine-dawn"}}, {"theme.set-scheme", map[string]string{"scheme": "light"}}},
			wantMsg: "light theme = GitHub Light (github-light), the default, was Rosé Pine Dawn (rose-pine-dawn)"},
		{name: "no slot: system, as the window shows", showing: "dark", wantKey: "appearance.theme_dark",
			setup:   [][2]any{{"theme.set-dark", map[string]string{"theme": "nord"}}},
			wantMsg: "dark theme = GitHub Dark (github-dark), the default, was Nord (nord)"},
		{name: "no slot: system and no window", wantErr: `the scheme is system and no app window says which the Mac shows`},
		{name: "a user theme in the slot stays a file", showing: "light", wantKey: "appearance.theme_light",
			setup:   [][2]any{{"theme.duplicate", map[string]string{"theme": "github-light"}}, {"theme.set-light", map[string]string{"theme": "github-light-copy"}}},
			args:    map[string]string{"slot": "light"},
			wantMsg: "light theme = GitHub Light (github-light), the default, was GitHub Light copy (github-light-copy)"},
		{name: "unknown slot", args: map[string]string{"slot": "sepia"}, wantErr: `argument "slot": want one of dark, light`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			store, err := settingstest.New(context.Background(), home, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			themes := usertheme.New(usertheme.Options{Dir: filepath.Join(home, "themes"), Log: slog.New(slog.DiscardHandler)})
			themes.Load()
			themes.OnChange(func(s *usertheme.Snapshot) { store.SetThemes(s.Set()) })
			showing := func() (string, bool) { return tt.showing, tt.showing != "" }
			reg := command.NewRegistry()
			if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: api.NewSettings(store), Themes: themes, Showing: showing}); err != nil {
				t.Fatal(err)
			}
			for _, s := range tt.setup {
				if _, err := reg.Invoke(context.Background(), command.Context{}, s[0].(string), s[1].(map[string]string), command.Confirmed(true)); err != nil {
					t.Fatalf("%s: %v", s[0], err)
				}
			}
			before := len(themes.Snapshot().Themes)
			res, err := reg.Invoke(context.Background(), command.Context{}, "theme.reset", tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid arg %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q\n want %q", res.Message, tt.wantMsg)
			}
			// The setting is gone from the file (the default again), and no theme file went.
			file, _ := os.ReadFile(store.Snapshot().Path)
			if name := tt.wantKey[strings.LastIndex(tt.wantKey, ".")+1:]; regexp.MustCompile(`(?m)^` + name + ` *=`).Match(file) {
				t.Errorf("%s still set in the file:\n%s", tt.wantKey, file)
			}
			if after := len(themes.Snapshot().Themes); after != before {
				t.Errorf("user themes = %d, was %d", after, before)
			}
		})
	}
}
