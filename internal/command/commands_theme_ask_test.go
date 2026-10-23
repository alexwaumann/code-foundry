package command_test

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
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
		message string   // the first message, exactly
		want    []string // substrings of the system prompt append
		mode    v1.PermissionMode
		model   string
		wantErr string
		setup   string // a light user theme with this id, saved first
	}{
		{name: "from the Themes page", uctx: gui, args: map[string]string{"description": "warm dark, teal accent"}, message: "warm dark, teal accent",
			want: []string{"The user asked for a colour theme on Code Foundry's Themes page (Ask the model); their first message in this thread describes it. " +
				"The current dark theme is Ocean Dusk (ocean-dusk) and the light theme is GitHub Light (github-light). ",
				"save it with `code-foundry theme save --file <path> --apply`", "(the code-foundry skill: Making a theme)."},
			mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "from the CLI, a model and supervised", args: map[string]string{"description": "sepia", "model": command.ThreadModels[0], "permission": "supervised"}, message: "sepia",
			want: []string{"The user wants a colour theme for Code Foundry; their first message"},
			mode: v1.PermissionMode_PERMISSION_MODE_SUPERVISED, model: command.ThreadModels[0]},
		{name: "a light pair", uctx: gui, args: map[string]string{"pair": "ocean-dusk"}, message: "Make a light pair for my theme Ocean Dusk.",
			want: []string{"They want a light pair for their theme ocean-dusk (`code-foundry theme show ocean-dusk` prints it): same hues, a light scheme, " +
				"saved as ocean-dusk-light (no theme has that id yet), applied as their light theme; then save ocean-dusk again with \"pair\": \"ocean-dusk-light\" " +
				"(with --replace: they asked for it) and give the new one \"pair\": \"ocean-dusk\"."},
			mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "a pair with words", uctx: gui, args: map[string]string{"pair": "ocean-dusk", "description": "a bit warmer"},
			message: "Make a light pair for my theme Ocean Dusk.\n\na bit warmer", want: []string{"saved as ocean-dusk-light ("},
			mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "nothing to ask", args: map[string]string{"description": "  "}, wantErr: "describe the theme"},
		{name: "a curated pair", args: map[string]string{"pair": "nord"}, wantErr: `Nord ("nord") is a curated theme; copy it first (theme duplicate nord)`},
		{name: "a pair id that is taken", uctx: gui, setup: "ocean-dusk-light", args: map[string]string{"pair": "ocean-dusk"},
			message: "Make a light pair for my theme Ocean Dusk.", want: []string{"saved as ocean-dusk-light-2 ("}, mode: v1.PermissionMode_PERMISSION_MODE_AUTO},
		{name: "too long", args: map[string]string{"description": strings.Repeat("x", command.MaxThemeAskBytes+1)}, wantErr: "keep it under"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.setup != "" {
				light, _ := theme.Curated("catppuccin-latte")
				light.ID, light.Name, light.Pair = tt.setup, "Old Paper", ""
				if _, err := themes.Save(light); err != nil {
					t.Fatal(err)
				}
			}
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
			// The bubble is the user's words; the context is the thread's system prompt.
			if req.GetInitialPrompt() != tt.message {
				t.Errorf("first message %q, want %q", req.GetInitialPrompt(), tt.message)
			}
			for _, w := range tt.want {
				if !strings.Contains(req.GetSystemPromptAppend(), w) {
					t.Errorf("system prompt append lacks %q:\n%s", w, req.GetSystemPromptAppend())
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

// The pair's id is one no theme has (theme-fuzz-daemon, files 13 / model 3): the scheme
// word swapped or the other scheme appended, numbered past a taken one, cut to 64.
func TestFreePairID(t *testing.T) {
	long := strings.Repeat("a", 55) + "-dusk"
	tests := []struct {
		name, id, scheme string
		taken            []string
		want             string
	}{
		{name: "appended", id: "ocean-dusk", scheme: "dark", want: "ocean-dusk-light"},
		{name: "the scheme word swapped", id: "ocean-dark", scheme: "dark", want: "ocean-light"},
		{name: "light to dark", id: "paper-light", scheme: "light", want: "paper-dark"},
		{name: "a bare scheme word", id: "dark", scheme: "dark", want: "dark-light"},
		{name: "taken by the user's theme", id: "ocean-dark", scheme: "dark", taken: []string{"ocean-light"}, want: "ocean-light-2"},
		{name: "taken twice", id: "ocean-dark", scheme: "dark", taken: []string{"ocean-light", "ocean-light-2"}, want: "ocean-light-3"},
		{name: "a curated id", id: "solarized", scheme: "dark", taken: []string{"solarized-light"}, want: "solarized-light-2"},
		{name: "too long", id: long, scheme: "dark", want: (long + "-light")[:64]},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := command.FreePairID(tt.id, tt.scheme, func(c string) bool { return slices.Contains(tt.taken, c) })
			if got != tt.want || !theme.ValidID(got) {
				t.Errorf("FreePairID(%s) = %q, want %q", tt.id, got, tt.want)
			}
		})
	}
}

