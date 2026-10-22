package command_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/settings/settingstest"
)

func newSettingsRegistry(t *testing.T) (*command.Registry, *commandtest.Emitter, *settingstest.Fake, *[]string) {
	t.Helper()
	store, err := settingstest.New(context.Background(), t.TempDir(), nil, []settings.CommandInfo{
		{Name: "thread.new", Title: "New Thread", Category: "Thread", Keybindings: []string{"cmd+n"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	var revealed []string
	reg := command.NewRegistry()
	e := &commandtest.Emitter{Delivered: 1, OpenWindows: 1}
	if err := command.RegisterView(reg, command.ViewDeps{Emitter: e}); err != nil {
		t.Fatal(err)
	}
	if err := command.RegisterSettings(reg, api.NewSettings(store), func(_ context.Context, p string) error {
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
			wantJSON: `{"key":"appearance.font_size","value":"13","default":"13","title":"Font size","description":"Size of terminal text, before zoom.","type":"int"}`},
		{name: "get all", cmd: "settings.get", wantMsg: `appearance.theme = "system"`,
			wantJSON: `{"key":"keybindings.thread.new","value":"cmd+n","default":"cmd+n","title":"New Thread","description":"","type":"keybinding"}`},
		{name: "get all: an enum", cmd: "settings.get",
			wantJSON: `{"key":"appearance.theme","value":"system","default":"system","title":"Scheme","description":"Dark or light. System follows the macOS appearance.","type":"enum"}`},
		{name: "get unknown", cmd: "settings.get", args: map[string]string{"key": "nope.nope"}, wantErr: command.ErrInvalidArgs},
		{name: "set", cmd: "settings.set", args: map[string]string{"key": "appearance.font_size", "value": "15"},
			wantMsg: `appearance.font_size = "15"`, wantJSON: `"value":"15","default":"13","title":"Font size"`},
		{name: "set restart field notes it", cmd: "settings.set", args: map[string]string{"key": "threads.scrollback_lines", "value": "20000"},
			wantMsg: "(applies after a daemon restart)"},
		{name: "set keybinding", cmd: "settings.set", args: map[string]string{"key": "keybindings.thread.new", "value": "Shift+Cmd+N"},
			wantMsg: `keybindings.thread.new = "cmd+shift+n"`},
		{name: "set invalid value", cmd: "settings.set", args: map[string]string{"key": "appearance.font_size", "value": "200"},
			wantCode: connect.CodeInvalidArgument},
		{name: "set reserved chord", cmd: "settings.set", args: map[string]string{"key": "keybindings.thread.new", "value": "cmd+k"},
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

// settings.get, set and reset warn (on stderr, via Result.Warnings) when the file does
// not parse or holds values the app ignores, so a hand edit gone wrong is not silent.
func TestSettingsWarnings(t *testing.T) {
	tests := []struct {
		name  string
		file  string
		cmd   string
		args  map[string]string
		want  []string // substrings, one per warning
		value string   // the message, when set
	}{
		{name: "clean file", file: "[appearance]\nfont_size = 15\n", cmd: "settings.get", args: map[string]string{"key": "appearance.font_size"}, value: "15"},
		{name: "does not parse", file: "[advanced]\n[advanced]\n", cmd: "settings.get", args: map[string]string{"key": "appearance.font_size"},
			want: []string{"does not parse", "the last settings that loaded are in effect"}, value: "13"},
		{name: "ignored value of the key", file: "[appearance]\nfont_size = 30000\n", cmd: "settings.get", args: map[string]string{"key": "appearance.font_size"},
			want: []string{"appearance.font_size in ", "is ignored: want 9 to 28, got 30000"}, value: "13"},
		{name: "ignored value of another key", file: "[appearance]\nfont_size = 30000\n", cmd: "settings.get", args: map[string]string{"key": "appearance.zoom"}, value: "100"},
		{name: "get all lists them", file: "[appearance]\nfont_size = 30000\n[threads]\nnope = 1\n", cmd: "settings.get",
			want: []string{"2 values are ignored", "appearance.font_size, threads.nope"}},
		{name: "set keeps them and says so", file: "[appearance]\nfont_size = 30000\n", cmd: "settings.set", args: map[string]string{"key": "appearance.zoom", "value": "110"},
			want: []string{"1 value is ignored in ", "(kept in the file until fixed", "appearance.font_size"}},
		{name: "reset another key", file: "[appearance]\nfont_size = 30000\n", cmd: "settings.reset", args: map[string]string{"key": "appearance.zoom"},
			want: []string{"1 value is ignored"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, settings.FileName), []byte(tt.file), 0o600); err != nil {
				t.Fatal(err)
			}
			store, err := settingstest.New(context.Background(), dir, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = store.Close() })
			reg := command.NewRegistry()
			if err := command.RegisterSettings(reg, api.NewSettings(store), nil); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), command.Context{}, tt.cmd, tt.args)
			if err != nil {
				t.Fatal(err)
			}
			if tt.value != "" && res.Message != tt.value {
				t.Errorf("message = %q, want %q", res.Message, tt.value)
			}
			got := strings.Join(res.Warnings, "\n")
			if len(res.Warnings) != min(len(tt.want), 1) { // one line, whatever it says
				t.Errorf("warnings = %q", res.Warnings)
			}
			for _, w := range tt.want {
				if !strings.Contains(got, w) {
					t.Errorf("warnings %q lack %q", got, w)
				}
			}
		})
	}
}
