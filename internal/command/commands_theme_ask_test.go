package command_test

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

func TestThemeAsk(t *testing.T) {
	home := t.TempDir()
	store, err := settingstest.New(context.Background(), home, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	themes := usertheme.New(usertheme.Options{Dir: filepath.Join(home, "themes"), Log: slog.New(slog.DiscardHandler)})
	themes.Load()
	themes.OnChange(func(s *usertheme.Snapshot) { store.SetThemes(s.Set()) })
	f, err := theme.ParseFile(oceanDusk(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := themes.Save(f); err != nil {
		t.Fatal(err)
	}
	reg := command.NewRegistry()
	settingsAPI := api.NewSettings(store)
	thr, emit := &commandtest.Thread{Current: &v1.Thread{Id: "s1", Name: "Tide pool"}}, &commandtest.Emitter{}
	if err := command.RegisterTheme(reg, command.ThemeDeps{Settings: settingsAPI, Themes: themes}); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterThemeAsk(reg, command.ThemeAskDeps{Thread: thr, Settings: settingsAPI, Themes: themes, Emitter: emit}); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Invoke(context.Background(), command.Context{}, "theme.set-dark", map[string]string{"theme": "ocean-dusk"}); err != nil {
		t.Fatal(err)
	}
	gui := command.Context{ActiveView: "themes"}
	tests := []struct {
		name    string
		uctx    command.Context
		args    map[string]string
		want    []string // substrings of the prompt
		mode    v1.PermissionMode
		model   string
		wantErr string
	}{
		{name: "from the Themes page", uctx: gui, args: map[string]string{"description": "warm dark, teal accent"},
			want: []string{"The user is on the Themes page; the current dark theme is Ocean Dusk (ocean-dusk) and light theme is GitHub Light (github-light). ",
				"save it with `code-foundry theme save --data - --apply`", "(the code-foundry skill: Making a theme).\n\nwarm dark, teal accent"},
			mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "from the CLI, a model and supervised", args: map[string]string{"description": "sepia", "model": command.ThreadModels[0], "permission": "supervised"},
			want: []string{"The user wants a colour theme for Code Foundry; the current dark theme", "\n\nsepia"},
			mode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED, model: command.ThreadModels[0]},
		{name: "a light pair", uctx: gui, args: map[string]string{"pair": "ocean-dusk"},
			want: []string{"Make a light pair for my theme ocean-dusk (`code-foundry theme show ocean-dusk` prints it): same hues, a light scheme, " +
				"saved as ocean-dusk-light with pair set both ways, applied as my light theme."},
			mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "nothing to ask", args: map[string]string{"description": "  "}, wantErr: "describe the theme"},
		{name: "a curated pair", args: map[string]string{"pair": "nord"}, wantErr: `"nord"`},
		{name: "too long", args: map[string]string{"description": strings.Repeat("x", command.MaxThemeAskBytes+1)}, wantErr: "keep it under"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before, intents := len(thr.Requests()), len(emit.Intents())
			res, err := reg.Invoke(context.Background(), tt.uctx, "theme.ask", tt.args)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				if len(thr.Requests()) != before {
					t.Error("a thread was started")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			reqs := thr.Requests()[before:]
			if len(reqs) != 1 {
				t.Fatalf("requests %v", reqs)
			}
			req, ok := reqs[0].(*v1.CreateThreadRequest)
			if !ok || !req.GetNoProject() || req.GetPermissionMode() != tt.mode || req.GetModel() != tt.model {
				t.Fatalf("create = %v", reqs[0])
			}
			for _, w := range tt.want {
				if !strings.Contains(req.GetInitialPrompt(), w) {
					t.Errorf("prompt lacks %q:\n%s", w, req.GetInitialPrompt())
				}
			}
			got := emit.Intents()[intents:]
			if len(got) != 1 || got[0].GetFocusThread().GetThreadId() != "s1" {
				t.Errorf("intents %v, want a focus of s1", got)
			}
			if !strings.Contains(res.Message, "started thread s1 to make the theme") {
				t.Errorf("message %q", res.Message)
			}
		})
	}
}

func TestThemePairAsk(t *testing.T) {
	tests := []struct {
		id, scheme, want string
	}{
		{"ocean-dusk", "dark", "saved as ocean-dusk-light"},
		{"ocean-dark", "dark", "saved as ocean-light"},
		{"paper-light", "light", "a dark scheme, saved as paper-dark"},
		{"dark", "dark", "saved as dark-light"},
	}
	for _, tt := range tests {
		if got := command.ThemePairAsk(theme.File{ID: tt.id, Scheme: tt.scheme}); !strings.Contains(got, tt.want) {
			t.Errorf("ThemePairAsk(%s) = %q, want %q", tt.id, got, tt.want)
		}
	}
}
