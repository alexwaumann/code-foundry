package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

type themeEnv struct {
	reg      *command.Registry
	settings *settingstest.Fake
	themes   *usertheme.Store
	dir      string
}

// newThemeEnv is a registry with the theme commands over a real settings store and a
// real themes directory, wired as the daemon wires them.
func newThemeEnv(t *testing.T) themeEnv {
	t.Helper()
	home := t.TempDir()
	store, err := settingstest.New(context.Background(), home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	dir := filepath.Join(home, "themes")
	themes := usertheme.New(usertheme.Options{Dir: dir, Log: slog.New(slog.DiscardHandler)})
	themes.Load()
	themes.OnChange(func(s *usertheme.Snapshot) { store.SetThemes(s.Set()) })
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: api.NewSettings(store), Themes: themes}); err != nil {
		t.Fatal(err)
	}
	return themeEnv{reg: reg, settings: store, themes: themes, dir: dir}
}

func (e themeEnv) invoke(t *testing.T, uctx command.Context, cmd string, args map[string]string) (command.Result, error) {
	t.Helper()
	return e.reg.Invoke(context.Background(), uctx, cmd, args, command.Confirmed(true))
}

func TestThemeCommands(t *testing.T) {
	env := newThemeEnv(t)
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		wantMsg  []string // substrings of the message
		wantJSON string   // substring of the JSON
		wantErr  string   // substring of the error
	}{
		{name: "list marks the defaults", cmd: "theme.list",
			wantMsg:  []string{"scheme: system (appearance.theme)", "dark themes (appearance.theme_dark):\n* github-dark ", "  dracula ", "light themes (appearance.theme_light):\n* github-light ", "change one of yours with theme edit <id>"},
			wantJSON: `"scheme":"system","dark":"github-dark","light":"github-light"`},
		{name: "set dark", cmd: "theme.set-dark", args: map[string]string{"theme": "dracula"},
			wantMsg: []string{"dark theme = Dracula (dracula)"}, wantJSON: `{"key":"appearance.theme_dark","id":"dracula","name":"Dracula","scheme":"dark"}`},
		{name: "set light", cmd: "theme.set-light", args: map[string]string{"theme": "rose-pine-dawn"},
			wantMsg: []string{"light theme = Rosé Pine Dawn (rose-pine-dawn)"}},
		{name: "list follows", cmd: "theme.list", wantMsg: []string{"* dracula ", "* rose-pine-dawn ", "  github-dark "},
			wantJSON: `{"id":"dracula","name":"Dracula","scheme":"dark","user":false,"selected":true}`},
		{name: "light id in the dark slot", cmd: "theme.set-dark", args: map[string]string{"theme": "catppuccin-latte"},
			wantErr: `argument "theme": Catppuccin Latte ("catppuccin-latte") is a light theme; the dark theme must be one of "github-dark", "catppuccin-mocha"`},
		{name: "unknown id", cmd: "theme.set-light", args: map[string]string{"theme": "sepia"}, wantErr: `unknown theme "sepia"; light themes are "github-light"`},
		{name: "missing id", cmd: "theme.set-dark", wantErr: `missing required argument "theme"`},
		{name: "show a curated theme", cmd: "theme.show", args: map[string]string{"theme": "nord"},
			wantMsg: []string{"{\n  \"id\": \"nord\",\n  \"name\": \"Nord\",", `"ansi": [`}, wantJSON: `"id":"nord"`},
		{name: "show an unknown theme", cmd: "theme.show", args: map[string]string{"theme": "sepia"}, wantErr: `no theme "sepia" (theme list prints the ids)`},
		{name: "delete a curated theme", cmd: "theme.delete", args: map[string]string{"theme": "nord"}, wantErr: `"nord" is a curated theme`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := env.invoke(t, command.Context{}, tt.cmd, tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid args %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, w := range tt.wantMsg {
				if !strings.Contains(res.Message, w) {
					t.Errorf("message lacks %q:\n%s", w, res.Message)
				}
			}
			js, _ := json.Marshal(res.JSON)
			if !strings.Contains(string(js), tt.wantJSON) {
				t.Errorf("json = %s, want %s", js, tt.wantJSON)
			}
		})
	}
	// A theme for the scheme not in use says how to see it.
	if _, err := env.settings.Update(context.Background(), map[string]string{"appearance.theme": "light"}); err != nil {
		t.Fatal(err)
	}
	res, err := env.invoke(t, command.Context{}, "theme.set-dark", map[string]string{"theme": "nord"})
	if err != nil || !strings.Contains(res.Message, "the scheme is light, so nothing changes on screen until it is dark (theme set-scheme dark switches it)") {
		t.Fatalf("message = %q, %v", res.Message, err)
	}
}

// oceanDusk is a user theme file copied from Catppuccin Mocha with two pinned slots.
func oceanDusk(t *testing.T) []byte {
	t.Helper()
	f, _ := theme.Curated("catppuccin-mocha")
	f.ID, f.Name, f.Pair, f.From, f.Source = "ocean-dusk", "Ocean Dusk", "", "catppuccin-mocha", ""
	f.Overrides = map[string]string{"--cf-accent": "#5fb3b3", "--cf-sidebar": "#0b141c"}
	return f.Marshal()
}

func TestThemeSaveDuplicateDelete(t *testing.T) {
	env := newThemeEnv(t)
	path := filepath.Join(t.TempDir(), "ocean.json")
	if err := os.WriteFile(path, oceanDusk(t), 0o600); err != nil {
		t.Fatal(err)
	}
	thread := command.Context{ActiveThreadID: "s-5f963f4547cc"}
	gui := command.Context{ActiveView: "themes", ActiveThreadID: "s-1"}

	steps := []struct {
		name    string
		uctx    command.Context
		cmd     string
		args    map[string]string
		wantMsg []string
		wantErr string // substring of the error
	}{
		{name: "save from a file, from a thread, applied", uctx: thread, cmd: "theme.save", args: map[string]string{"file": path, "apply": "true"},
			wantMsg: []string{"saved Ocean Dusk (ocean-dusk), a dark theme", "from: Catppuccin Mocha (catppuccin-mocha)", "pinned: 2 slots", "contrast: not checked (this daemon keeps no contrast reports)",
				"written to: " + filepath.Join(env.dir, "ocean-dusk.json"), "applied: dark theme = Ocean Dusk (ocean-dusk)"}},
		{name: "list shows it first, marked", cmd: "theme.list",
			wantMsg: []string{"dark themes (appearance.theme_dark):\n* ocean-dusk ", "Ocean Dusk  [yours, from catppuccin-mocha, by thread s-5f963f4547cc]"}},
		{name: "save the same id again, as JSON", cmd: "theme.save", args: map[string]string{"data": string(oceanDusk(t))},
			wantMsg: []string{"replaced Ocean Dusk (ocean-dusk)"}},
		{name: "a curated id", cmd: "theme.save", args: map[string]string{"data": strings.Replace(string(oceanDusk(t)), `"ocean-dusk"`, `"nord"`, 1)},
			wantErr: `"nord" is a curated theme's id; save under another id (theme duplicate nord makes a copy)`},
		{name: "an invalid file", cmd: "theme.save", args: map[string]string{"data": `{"id":"x"}`}, wantErr: "the theme does not validate: no name"},
		{name: "not JSON", cmd: "theme.save", args: map[string]string{"data": "nope"}, wantErr: "not JSON"},
		{name: "neither", cmd: "theme.save", wantErr: "give the theme file: --file <path>, or --data - to read it from stdin"},
		{name: "both", cmd: "theme.save", args: map[string]string{"file": path, "data": "{}"}, wantErr: "not both"},
		{name: "a missing file", cmd: "theme.save", args: map[string]string{"file": path + ".nope"}, wantErr: "no such file"},
		{name: "set the slot to the user theme", cmd: "theme.set-dark", args: map[string]string{"theme": "ocean-dusk"}, wantMsg: []string{"dark theme = Ocean Dusk (ocean-dusk)"}},
		{name: "the light slot refuses it", cmd: "theme.set-light", args: map[string]string{"theme": "ocean-dusk"}, wantErr: `Ocean Dusk ("ocean-dusk") is a dark theme`},
		{name: "duplicate a curated theme from the GUI", uctx: gui, cmd: "theme.duplicate", args: map[string]string{"theme": "gruvbox-dark"},
			wantMsg: []string{"saved Gruvbox Dark copy (gruvbox-dark-copy), a dark theme", "from: Gruvbox Dark (gruvbox-dark)", "pinned: 0 slots"}},
		{name: "duplicate it again, named", cmd: "theme.duplicate", args: map[string]string{"theme": "gruvbox-dark", "name": "Gruvbox, warmer"},
			wantMsg: []string{"saved Gruvbox, warmer (gruvbox-dark-copy-2)"}},
		{name: "duplicate a user theme", cmd: "theme.duplicate", args: map[string]string{"theme": "ocean-dusk"},
			wantMsg: []string{"saved Ocean Dusk copy (ocean-dusk-copy)", "from: Ocean Dusk (ocean-dusk)", "pinned: 2 slots"}},
		{name: "show a user theme", cmd: "theme.show", args: map[string]string{"theme": "ocean-dusk"},
			wantMsg: []string{`"from": "catppuccin-mocha",`, `"--cf-accent": "#5fb3b3"`}},
		{name: "delete the theme in use", cmd: "theme.delete", args: map[string]string{"theme": "ocean-dusk"},
			wantMsg: []string{"deleted Ocean Dusk (ocean-dusk)", "now dark theme = Catppuccin Mocha (catppuccin-mocha)"}},
		{name: "delete it again", cmd: "theme.delete", args: map[string]string{"theme": "ocean-dusk"}, wantErr: `no theme "ocean-dusk" among yours`},
		{name: "delete one not in use", cmd: "theme.delete", args: map[string]string{"theme": "gruvbox-dark-copy"}, wantMsg: []string{"deleted Gruvbox Dark copy (gruvbox-dark-copy)"}},
	}
	for _, st := range steps {
		res, err := env.invoke(t, st.uctx, st.cmd, st.args)
		if st.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), st.wantErr) {
				t.Fatalf("%s: err = %v, want %q", st.name, err, st.wantErr)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		for _, w := range st.wantMsg {
			if !strings.Contains(res.Message, w) {
				t.Errorf("%s: message lacks %q:\n%s", st.name, w, res.Message)
			}
		}
	}

	// The thread was recorded; the GUI's copy has none.
	snap := env.themes.Snapshot()
	if f, ok := snap.Get("ocean-dusk-copy"); !ok || f.CreatedBy != "" || f.From != "ocean-dusk" {
		t.Errorf("copy = %+v, %v", f.Theme(), ok)
	}
	if f, ok := snap.Get("gruvbox-dark-copy-2"); !ok || f.Pair != "" { // a copy has no pair
		t.Errorf("named copy = %+v", f.Theme())
	}
	// The delete moved the slot off the theme before removing it: no issue.
	if s := env.settings.Snapshot(); s.Values["appearance.theme_dark"] != "catppuccin-mocha" || len(s.Issues) != 0 {
		t.Errorf("settings = %q, issues %v", s.Values["appearance.theme_dark"], s.Issues)
	}
	// A file made by hand that does not load is listed with why.
	if err := os.WriteFile(filepath.Join(env.dir, "broken.json"), []byte(`{"id":"broken"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	env.themes.Load()
	res, err := env.invoke(t, command.Context{}, "theme.list", nil)
	if err != nil || !strings.Contains(res.Message, "not loaded (fix the file in " + env.dir + ", or remove it with theme delete --file <name>):\n  broken.json: no name") {
		t.Errorf("list = %q, %v", res.Message, err)
	}
	if js, _ := json.Marshal(res.JSON); !strings.Contains(string(js), `"issues":[{"file":"broken.json","message":"no name"}]`) {
		t.Errorf("list json = %s", js)
	}
}

func TestThemeDeleteConfirm(t *testing.T) {
	env := newThemeEnv(t)
	if _, err := env.invoke(t, command.Context{}, "theme.save", map[string]string{"data": string(oceanDusk(t)), "apply": "true"}); err != nil {
		t.Fatal(err)
	}
	_, err := env.reg.Invoke(context.Background(), command.Context{}, "theme.delete", map[string]string{"theme": "ocean-dusk"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || ce.Message != "Delete the theme Ocean Dusk? Its file in the themes directory is removed. It is your dark theme; the dark theme becomes Catppuccin Mocha." || ce.Label != "Delete" {
		t.Fatalf("err = %#v", err)
	}
	if _, ok := env.themes.Snapshot().Get("ocean-dusk"); !ok {
		t.Error("deleted without a confirm")
	}
}

func TestThemeCommandsWithoutThemes(t *testing.T) {
	store, err := settingstest.New(context.Background(), t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: api.NewSettings(store)}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), command.Context{}, "theme.show", map[string]string{"theme": "nord"}); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("show = %v", err)
	}
	if res, err := reg.Invoke(context.Background(), command.Context{}, "theme.list", nil); err != nil || strings.Contains(res.Message, "theme edit <id>") {
		t.Errorf("list = %q, %v", res.Message, err)
	}
}
