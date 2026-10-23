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

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// The theme fuzz pass's verb fixes (docs/notes/theme-fuzz-daemon.md).

// failingUpdates is a settings backend whose Update fails once fail is set.
type failingUpdates struct {
	command.SettingsBackend
	fail error
}

func (f *failingUpdates) Update(ctx context.Context, req *connect.Request[v1.UpdateSettingsRequest]) (*connect.Response[v1.UpdateSettingsResponse], error) {
	if f.fail != nil {
		return nil, f.fail
	}
	return f.SettingsBackend.Update(ctx, req)
}

type fuzzEnv struct {
	themeEnv
	backend *failingUpdates
	cards   *commandtest.Thread
	showing string
}

func newFuzzEnv(t *testing.T) *fuzzEnv {
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
	e := &fuzzEnv{backend: &failingUpdates{SettingsBackend: api.NewSettings(store)}, cards: &commandtest.Thread{}}
	reg := command.NewRegistry()
	if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: e.backend, Themes: themes, Cards: e.cards,
		Showing: func() (string, bool) { return e.showing, e.showing != "" }}); err != nil {
		t.Fatal(err)
	}
	e.themeEnv = themeEnv{reg: reg, settings: store, themes: themes, dir: dir}
	return e
}

// lightOcean is oceanDusk as a light theme (Latte's base).
func lightOcean(t *testing.T, id string) string {
	t.Helper()
	f, _ := theme.Curated("catppuccin-latte")
	f.ID, f.Name, f.Pair, f.From, f.Source = id, "Ocean Day", "", "catppuccin-latte", ""
	return string(f.Marshal())
}

// Saves that would lose something are refused: a scheme change under the slot that shows
// the theme (files 1), a thread replacing a theme it did not make (model 3).
func TestThemeSaveGuards(t *testing.T) {
	threadA := command.Context{ActiveThreadID: "s-aaaaaaaaaaaa"}
	threadB := command.Context{ActiveThreadID: "s-bbbbbbbbbbbb"}
	dusk := string(oceanDusk(t))
	tests := []struct {
		name    string
		setup   []map[string]string // theme.save args from the terminal, in order
		uctx    command.Context
		args    map[string]string
		wantErr string // substring; "" = saved
		check   func(t *testing.T, e *fuzzEnv)
	}{
		{name: "a dark theme in use made light", setup: []map[string]string{{"data": dusk, "apply": "true"}},
			args: map[string]string{"data": lightOcean(t, "ocean-dusk")}, wantErr: "ocean-dusk is your dark theme; a light theme needs another id"},
		{name: "a dark theme not in use made light", setup: []map[string]string{{"data": dusk}},
			args: map[string]string{"data": lightOcean(t, "ocean-dusk")}},
		{name: "a thread over the user's own theme", setup: []map[string]string{{"data": dusk}}, uctx: threadA,
			args: map[string]string{"data": dusk}, wantErr: "Ocean Dusk (ocean-dusk) is a theme this thread did not make (one the user made)"},
		{name: "--replace: saved, and the maker stays", setup: []map[string]string{{"data": dusk}}, uctx: threadA,
			args: map[string]string{"data": dusk, "replace": "true"}, check: func(t *testing.T, e *fuzzEnv) {
				if f, _ := e.themes.Snapshot().Get("ocean-dusk"); f.CreatedBy != "" {
					t.Errorf("created_by = %q, want the user's (none)", f.CreatedBy)
				}
			}},
		{name: "a thread refining its own theme", uctx: threadA, args: map[string]string{"data": dusk}, check: func(t *testing.T, e *fuzzEnv) {
			if _, err := e.invoke(t, threadA, "theme.save", map[string]string{"data": strings.Replace(dusk, "#5fb3b3", "#6fc3c3", 1)}); err != nil {
				t.Errorf("refinement: %v", err)
			}
			_, err := e.invoke(t, threadB, "theme.save", map[string]string{"data": dusk})
			if err == nil || !strings.Contains(err.Error(), "(made by thread s-aaaaaaaaaaaa)") {
				t.Errorf("another thread: %v", err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFuzzEnv(t)
			for _, s := range tt.setup {
				if _, err := e.invoke(t, command.Context{}, "theme.save", s); err != nil {
					t.Fatal(err)
				}
			}
			_, err := e.invoke(t, tt.uctx, "theme.save", tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				if s := e.settings.Snapshot(); len(s.Issues) != 0 {
					t.Errorf("settings issues after a refused save: %v", s.Issues)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tt.check != nil {
				tt.check(t, e)
			}
		})
	}
}

// --apply that fails after the file is written says both (files 7); from a thread the card
// is still added, not applied.
func TestThemeSaveApplyFailure(t *testing.T) {
	e := newFuzzEnv(t)
	e.backend.fail = connect.NewError(connect.CodeInvalidArgument, errors.New("invalid settings: settings file has a syntax error"))
	_, err := e.invoke(t, command.Context{ActiveThreadID: "s-1"}, "theme.save", map[string]string{"data": string(oceanDusk(t)), "apply": "true"})
	if !command.IsFailed(err) || !strings.Contains(err.Error(), "saved Ocean Dusk (ocean-dusk), a dark theme") ||
		!strings.Contains(err.Error(), "\nnot applied: settings file has a syntax error") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := e.themes.Snapshot().Get("ocean-dusk"); !ok {
		t.Error("not saved")
	}
	if reqs := e.cards.Requests(); len(reqs) != 1 || reqs[0].(*v1.ShowThreadThemeRequest).GetTheme().GetApplied() {
		t.Errorf("card requests = %v", reqs)
	}
}

// What a slot set says about the scheme the app shows (model 8): nothing when it shows,
// the scheme and the switch when not, system resolved by the window.
func TestThemeSchemeNote(t *testing.T) {
	tests := []struct {
		name, pref, showing, want string
	}{
		{name: "dark scheme", pref: "dark", want: "; the scheme is dark, so nothing changes on screen until it is light (theme set-scheme light switches it)"},
		{name: "light scheme", pref: "light"},
		{name: "system, currently dark", pref: "system", showing: "dark",
			want: "; the scheme is system, currently dark, so nothing changes on screen until the Mac is light (theme set-scheme light switches the app)"},
		{name: "system, currently light", pref: "system", showing: "light"},
		{name: "system, no window", pref: "system", want: "; the scheme is system (the Mac's appearance decides), so it shows while the Mac is light"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newFuzzEnv(t)
			e.showing = tt.showing
			if _, err := e.invoke(t, command.Context{}, "theme.set-scheme", map[string]string{"scheme": tt.pref}); err != nil {
				t.Fatal(err)
			}
			res, err := e.invoke(t, command.Context{}, "theme.set-light", map[string]string{"theme": "catppuccin-latte"})
			if err != nil || res.Message != "light theme = Catppuccin Latte (catppuccin-latte)"+tt.want {
				t.Errorf("message = %q, %v", res.Message, err)
			}
			list, _ := e.invoke(t, command.Context{}, "theme.list", nil)
			if tt.pref == "system" && tt.showing != "" && !strings.Contains(list.Message, "scheme: system (appearance.theme), currently "+tt.showing+"\n") {
				t.Errorf("list = %q", list.Message)
			}
		})
	}
}

func TestThemeSetScheme(t *testing.T) {
	e := newFuzzEnv(t)
	for _, tt := range []struct{ scheme, want string }{
		{"light", "scheme = light (appearance.theme): the app shows GitHub Light (github-light)"},
		{"system", "scheme = system (appearance.theme): the app follows the Mac: GitHub Dark (github-dark) when dark, GitHub Light (github-light) when light"},
	} {
		res, err := e.invoke(t, command.Context{}, "theme.set-scheme", map[string]string{"scheme": tt.scheme})
		if err != nil || res.Message != tt.want || e.settings.Snapshot().Values["appearance.theme"] != tt.scheme {
			t.Errorf("%s: %q, %v", tt.scheme, res.Message, err)
		}
	}
	if _, err := e.invoke(t, command.Context{}, "theme.set-scheme", map[string]string{"scheme": "sepia"}); !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("sepia: %v", err)
	}
}

// theme.restore puts back the version a save replaced (a card's Undo, files 2).
func TestThemeRestore(t *testing.T) {
	e := newFuzzEnv(t)
	dusk := string(oceanDusk(t))
	if _, err := e.invoke(t, command.Context{}, "theme.save", map[string]string{"data": dusk}); err != nil {
		t.Fatal(err)
	}
	first, _ := e.themes.Snapshot().Get("ocean-dusk")
	if _, err := e.invoke(t, command.Context{}, "theme.save", map[string]string{"data": strings.Replace(dusk, "#5fb3b3", "#6fc3c3", 1)}); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, theme, version, wantMsg, wantErr string
	}{
		{name: "the version before", theme: "ocean-dusk", version: first.Version(), wantMsg: "restored Ocean Dusk (ocean-dusk) to an earlier version"},
		{name: "a version never kept", theme: "ocean-dusk", version: strings.Repeat("0", 32), wantErr: "no longer kept"},
		{name: "a curated theme", theme: "nord", version: first.Version(), wantErr: `Nord ("nord") is a curated theme; copy it first (theme duplicate nord)`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := e.invoke(t, command.Context{}, "theme.restore", map[string]string{"theme": tt.theme, "version": tt.version})
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || !strings.HasPrefix(res.Message, tt.wantMsg) {
				t.Fatalf("message = %q, %v", res.Message, err)
			}
			if f, _ := e.themes.Snapshot().Get("ocean-dusk"); f.Version() != first.Version() {
				t.Error("not restored")
			}
		})
	}
}

// theme.delete removes a file that did not load (files 6), asks first only for what it
// can delete (files 16), and puts the slot back when the file cannot be removed (files 11).
func TestThemeDeleteFiles(t *testing.T) {
	e := newFuzzEnv(t)
	if _, err := e.invoke(t, command.Context{}, "theme.save", map[string]string{"data": string(oceanDusk(t)), "apply": "true"}); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"broken.json": "{", "ocean-dusk copy.json": string(oceanDusk(t))} {
		if err := os.WriteFile(filepath.Join(e.dir, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	e.themes.Load()
	confirm := func(args map[string]string) string {
		_, err := e.reg.Invoke(context.Background(), command.Context{}, "theme.delete", args)
		var ce *command.ConfirmError
		if errors.As(err, &ce) {
			return ce.Message
		}
		return ""
	}
	tests := []struct {
		name        string
		args        map[string]string
		wantConfirm string // "" = no confirmation
		wantMsg     string
		wantErr     string
	}{
		{name: "a curated theme is refused without asking", args: map[string]string{"theme": "nord"}, wantErr: `"nord" is a curated theme`},
		{name: "an unknown id", args: map[string]string{"theme": "sepia"}, wantErr: `no theme "sepia" among yours`},
		{name: "both", args: map[string]string{"theme": "x", "file": "y"}, wantErr: "not both"},
		{name: "neither", args: map[string]string{}, wantErr: "--file <name>"},
		{name: "a file that is not listed", args: map[string]string{"file": "../settings.toml"}, wantErr: "no file \"../settings.toml\""},
		{name: "a file by its name", args: map[string]string{"file": "ocean-dusk copy.json"},
			wantConfirm: "Delete the file ocean-dusk copy.json from the themes directory? It did not load: its id",
			wantMsg:     "deleted the file ocean-dusk copy.json (it did not load: its id \"ocean-dusk\" is taken by ocean-dusk.json"},
		{name: "a file by the id of its name", args: map[string]string{"theme": "broken"},
			wantConfirm: "Delete the file broken.json from the themes directory? It did not load: not JSON", wantMsg: "deleted the file broken.json"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := confirm(tt.args); !strings.HasPrefix(got, tt.wantConfirm) || (tt.wantConfirm == "") != (got == "") {
				t.Errorf("confirm = %q, want %q", got, tt.wantConfirm)
			}
			res, err := e.invoke(t, command.Context{}, "theme.delete", tt.args)
			if tt.wantErr != "" {
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || !strings.HasPrefix(res.Message, tt.wantMsg) {
				t.Fatalf("message = %q, %v", res.Message, err)
			}
		})
	}
	if is := e.themes.Snapshot().Issues; len(is) != 0 {
		t.Errorf("issues left: %v", is)
	}

	// A delete that fails leaves the slot on the theme.
	if err := os.Chmod(e.dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(e.dir, 0o700) })
	_, err := e.invoke(t, command.Context{}, "theme.delete", map[string]string{"theme": "ocean-dusk"})
	if !command.IsFailed(err) || !strings.Contains(err.Error(), "Ocean Dusk (ocean-dusk) is not deleted, so the dark theme is back on it") {
		t.Fatalf("err = %v", err)
	}
	if v := e.settings.Snapshot().Values["appearance.theme_dark"]; v != "ocean-dusk" {
		t.Errorf("dark slot = %q, want ocean-dusk", v)
	}
	js, _ := json.Marshal(e.settings.Snapshot().Issues)
	if string(js) != "null" {
		t.Errorf("settings issues = %s", js)
	}
}
