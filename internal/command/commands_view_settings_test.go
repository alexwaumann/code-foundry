package command_test

import (
	"context"
	"errors"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

func TestViewSettingsPage(t *testing.T) {
	store, err := settingstest.New(context.Background(), t.TempDir(), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	schema := api.NewSettings(store)
	inThread := command.Context{ActiveThreadID: "s1", CallerThreadID: "s1"}
	tests := []struct {
		name     string
		ctx      command.Context
		args     map[string]string
		noSchema bool
		viewed   bool
		wantView string
		wantErr  string
		wantCode connect.Code
	}{
		{name: "no page: the page it shows", wantView: command.ViewSettings},
		{name: "a GUI page", args: map[string]string{"page": "memory"}, wantView: "settings.memory"},
		{name: "a schema page", args: map[string]string{"page": "appearance"}, wantView: "settings.appearance"},
		{name: "a page in both", args: map[string]string{"page": "plugins"}, wantView: "settings.plugins"},
		{name: "skills", args: map[string]string{"page": "skills"}, wantView: "settings.skills"},
		{name: "unknown page lists the ids", args: map[string]string{"page": "dictation"},
			wantErr: `no settings page "dictation"; the pages are general, appearance, notifications, source, ember, keybindings, advanced, plugins, skills, memory`},
		{name: "without a schema only the GUI's own", noSchema: true, args: map[string]string{"page": "appearance"},
			wantErr: "the pages are plugins, skills, memory"},
		{name: "from a page in a thread a window shows", ctx: inThread, viewed: true, args: map[string]string{"page": "memory"}, wantView: "settings.memory"},
		{name: "from a thread no window shows", ctx: inThread, args: map[string]string{"page": "memory"}, wantCode: connect.CodeFailedPrecondition},
		{name: "from a thread no window shows, --focus", ctx: inThread, args: map[string]string{"page": "memory", "focus": "true"}, wantView: "settings.memory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			emit := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
			deps := command.ViewDeps{Emitter: emit, Viewed: func(string) bool { return tt.viewed }}
			if !tt.noSchema {
				deps.Settings = schema
			}
			reg := command.NewRegistry()
			if err := command.RegisterView(reg, deps); err != nil {
				t.Fatal(err)
			}
			_, err := reg.Invoke(context.Background(), tt.ctx, "view.settings", tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
			case tt.wantErr != "":
				if !errors.Is(err, command.ErrInvalidArgs) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want invalid arg %q", err, tt.wantErr)
				}
			case err != nil:
				t.Fatal(err)
			}
			var got []string
			for _, i := range emit.Intents() {
				got = append(got, i.GetShowView().GetName())
			}
			if want := []string{tt.wantView}; tt.wantView != "" && !slices.Equal(got, want) || tt.wantView == "" && len(got) != 0 {
				t.Errorf("ShowViews = %q, want %q", got, tt.wantView)
			}
		})
	}
}

// SettingsGUIPages is the GUI's own pages, in guiPages.ts's order.
func TestSettingsGUIPagesMatchTheGUI(t *testing.T) {
	src, err := os.ReadFile("../../gui/frontend/src/components/settings/guiPages.ts")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, m := range regexp.MustCompile(`page: \{\s*id: "([a-z0-9-]+)"`).FindAllStringSubmatch(string(src), -1) {
		ids = append(ids, m[1])
	}
	if !slices.Equal(ids, command.SettingsGUIPages) {
		t.Fatalf("guiPages.ts has %q, SettingsGUIPages %q", ids, command.SettingsGUIPages)
	}
}
