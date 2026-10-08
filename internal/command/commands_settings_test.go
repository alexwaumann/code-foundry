package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/awaumann/code-foundry/internal/api"
	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
	"github.com/awaumann/code-foundry/internal/store/settings"
	"github.com/awaumann/code-foundry/internal/store/settings/settingstest"
)

func newSettingsRegistry(t *testing.T) (*command.Registry, *commandtest.Emitter, *settingstest.Fake, *[]string) {
	t.Helper()
	store, err := settingstest.New(context.Background(), t.TempDir(), nil, []settings.CommandInfo{
		{Name: "session.new", Title: "New Session", Category: "Session", Keybindings: []string{"cmd+n"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	var revealed []string
	reg := command.NewRegistry()
	e := &commandtest.Emitter{Delivered: 1}
	if err := command.RegisterSettings(reg, api.NewSettings(store), e, func(_ context.Context, p string) error {
		revealed = append(revealed, p)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return reg, e, store, &revealed
}

func TestSettingsCommands(t *testing.T) {
	tests := []struct {
		name     string
		cmd      string
		args     map[string]string
		wantMsg  string // substring of the message
		wantJSON string // substring of the JSON
		wantErr  error
		wantCode connect.Code
	}{
		{name: "get one", cmd: "settings.get", args: map[string]string{"key": "appearance.font_size"}, wantMsg: "13",
			wantJSON: `{"key":"appearance.font_size","value":"13","default":"13"}`},
		{name: "get all", cmd: "settings.get", wantMsg: `appearance.theme = "system"`, wantJSON: `"key":"keybindings.session.new","value":"cmd+n"`},
		{name: "get unknown", cmd: "settings.get", args: map[string]string{"key": "nope.nope"}, wantErr: command.ErrInvalidArgs},
		{name: "set", cmd: "settings.set", args: map[string]string{"key": "appearance.font_size", "value": "15"},
			wantMsg: `appearance.font_size = "15"`},
		{name: "set restart field notes it", cmd: "settings.set", args: map[string]string{"key": "sessions.scrollback_lines", "value": "20000"},
			wantMsg: "(applies after a daemon restart)"},
		{name: "set keybinding", cmd: "settings.set", args: map[string]string{"key": "keybindings.session.new", "value": "Shift+Cmd+N"},
			wantMsg: `keybindings.session.new = "cmd+shift+n"`},
		{name: "set invalid value", cmd: "settings.set", args: map[string]string{"key": "appearance.font_size", "value": "200"},
			wantCode: connect.CodeInvalidArgument},
		{name: "set reserved chord", cmd: "settings.set", args: map[string]string{"key": "keybindings.session.new", "value": "cmd+k"},
			wantCode: connect.CodeInvalidArgument},
		{name: "set needs a value", cmd: "settings.set", args: map[string]string{"key": "appearance.font_size"}, wantErr: command.ErrInvalidArgs},
		{name: "reset", cmd: "settings.reset", args: map[string]string{"key": "appearance.theme"}, wantMsg: `appearance.theme = "system" (default)`},
		{name: "path", cmd: "settings.path", wantMsg: "settings.toml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, _, _, _ := newSettingsRegistry(t)
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			switch {
			case tt.wantCode != 0:
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				return
			case !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if !strings.Contains(res.Message, tt.wantMsg) {
				t.Errorf("message = %q, want containing %q", res.Message, tt.wantMsg)
			}
			js, _ := res.EncodeJSON()
			if !strings.Contains(js, tt.wantJSON) {
				t.Errorf("json = %s, want containing %s", js, tt.wantJSON)
			}
		})
	}
}

func TestSettingsRevealAndViews(t *testing.T) {
	reg, e, store, revealed := newSettingsRegistry(t)
	ctx := context.Background()
	if _, err := reg.Invoke(ctx, command.Context{}, "settings.reveal", nil); err != nil {
		t.Fatal(err)
	}
	if len(*revealed) != 1 || (*revealed)[0] != store.Snapshot().Path {
		t.Errorf("revealed = %v", *revealed)
	}
	for _, tt := range []struct{ cmd, view, chord string }{
		{"view.settings", command.ViewSettings, "cmd+,"},
		{"view.help", command.ViewHelp, "cmd+/"},
	} {
		if _, err := reg.Invoke(ctx, command.Context{}, tt.cmd, nil); err != nil {
			t.Fatal(err)
		}
		in := e.Intents()
		if got := in[len(in)-1].GetShowView().GetName(); got != tt.view {
			t.Errorf("%s emitted view %q, want %q", tt.cmd, got, tt.view)
		}
		if c, _ := reg.Get(tt.cmd); len(c.Keybindings) != 1 || c.Keybindings[0] != tt.chord {
			t.Errorf("%s keybindings = %v", tt.cmd, c.Keybindings)
		}
	}
}
