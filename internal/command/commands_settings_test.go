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

// Who may change what. A user-only setting is the user's alone; a page asks first for any
// other; a thread's CLI and everyone else change an ordinary setting as they always did.
func TestSettingChangeCallers(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	const (
		ok = iota
		asks
		refused
	)
	callers := []struct {
		name string
		ctx  command.Context
		yes  bool // the Invoke is confirmed
		// What happens to an ordinary and to a user-only setting.
		ordinary, userOnly int
	}{
		{name: "the app", ctx: command.Context{ActiveView: "settings"}, ordinary: ok, userOnly: ok},
		{name: "the app, a thread selected", ctx: command.Context{ActiveView: "thread", ActiveThreadID: "s-1"}, ordinary: ok, userOnly: ok},
		{name: "a plain CLI", ctx: command.Context{}, ordinary: ok, userOnly: ok},
		{name: "a thread's CLI", ctx: command.Context{ActiveThreadID: "s-1"}, ordinary: ok, userOnly: refused},
		{name: "a thread's CLI with --yes", ctx: command.Context{ActiveThreadID: "s-1"}, yes: true, ordinary: ok, userOnly: refused},
		{name: "a page", ctx: command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}, ordinary: asks, userOnly: refused},
		{name: "a page, confirmed", ctx: command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}, yes: true, ordinary: ok, userOnly: refused},
		{name: "a page with a view", ctx: command.Context{ActiveView: "settings", Origin: command.OriginPage}, yes: true, ordinary: ok, userOnly: refused},
		{name: "an unknown caller", ctx: command.Context{ActiveThreadID: "s-1", Origin: command.OriginUnknown}, ordinary: asks, userOnly: refused},
		{name: "a thread's CLI, naming itself", ctx: command.Context{ActiveThreadID: "s-1", Origin: command.OriginCLI}, ordinary: ok, userOnly: refused},
		{name: "a plain CLI, naming itself", ctx: command.Context{Origin: command.OriginCLI}, ordinary: ok, userOnly: ok},
		{name: "a plugin", ctx: command.Context{Origin: command.OriginPlugin}, ordinary: ok, userOnly: refused},
		{name: "a plugin with a view", ctx: command.Context{ActiveView: "settings", Origin: command.OriginPlugin}, ordinary: ok, userOnly: refused},
	}
	settings := []struct {
		name     string
		cmd      string
		key      string
		value    string // set's; reset's is the default
		userOnly bool
		want     string // what a page's dialog says
		label    string
	}{
		{name: "set", cmd: "settings.set", key: "appearance.font_size", value: "15", want: `Change appearance.font_size to "15"?`, label: "Change"},
		{name: "reset", cmd: "settings.reset", key: "appearance.font_size", want: `Reset appearance.font_size to its default, "13"?`, label: "Reset"},
		{name: "set the claude path", cmd: "settings.set", key: "advanced.claude_path", value: exe, userOnly: true},
		{name: "reset the claude path", cmd: "settings.reset", key: "advanced.claude_path", userOnly: true},
		{name: "set the gh path", cmd: "settings.set", key: "advanced.gh_path", value: exe, userOnly: true},
		{name: "set the editor", cmd: "settings.set", key: "gitops.editor_command", value: "other {path}", userOnly: true},
		{name: "reset the editor", cmd: "settings.reset", key: "gitops.editor_command", userOnly: true},
		{name: "set the registries", cmd: "settings.set", key: "plugins.registries", value: "https://github.com/o/r", userOnly: true},
		{name: "set the channel", cmd: "settings.set", key: "update.channel", value: "tip", userOnly: true},
	}
	for _, c := range callers {
		for _, s := range settings {
			t.Run(c.name+"/"+s.name, func(t *testing.T) {
				reg, _, store, _ := newSettingsRegistry(t)
				// A value to reset from, and the file as it stood.
				seed := map[string]string{"appearance.font_size": "20", "advanced.claude_path": exe, "gitops.editor_command": "code"}
				if _, err := store.Update(context.Background(), seed); err != nil {
					t.Fatal(err)
				}
				before := store.Snapshot().Values[s.key]
				args := map[string]string{"key": s.key}
				if s.cmd == "settings.set" {
					args["value"] = s.value
				}
				_, err := reg.Invoke(context.Background(), c.ctx, s.cmd, args, command.Confirmed(c.yes))
				after := store.Snapshot().Values[s.key]

				want := c.ordinary
				if s.userOnly {
					want = c.userOnly
				}
				var ce *command.ConfirmError
				switch want {
				case ok:
					if err != nil {
						t.Fatalf("refused: %v", err)
					}
					if s.cmd == "settings.set" && after != s.value {
						t.Errorf("value = %q, want %q", after, s.value)
					}
				case asks:
					if !errors.As(err, &ce) || ce.Command != s.cmd || ce.Message != s.want || ce.Label != s.label || len(ce.Args) != 0 {
						t.Fatalf("err = %#v, want the confirmation %q", err, s.want)
					}
					if after != before {
						t.Errorf("changed before the answer: %q -> %q", before, after)
					}
				case refused:
					want := s.key + " can only be changed by the user; they can change it in Settings"
					if errors.As(err, &ce) {
						t.Fatalf("asked %q: a user-only setting is refused, not asked", ce.Message)
					}
					if !command.IsFailed(err) || err.Error() != want {
						t.Fatalf("err = %v, want %q", err, want)
					}
					if after != before {
						t.Errorf("changed: %q -> %q", before, after)
					}
				}
			})
		}
	}
}

// A dialog shows the start of a long value and says how much it left out.
func TestSettingChangeDialogCapsTheValue(t *testing.T) {
	page := command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}
	for _, tc := range []struct {
		name, value, want string
	}{
		{"at the cap", strings.Repeat("a", 200), `"` + strings.Repeat("a", 200) + `"?`},
		{"past it", strings.Repeat("a", 6085), `"` + strings.Repeat("a", 200) + `"… (5885 more characters not shown)?`},
		{"counted in characters", strings.Repeat("é", 201), `"` + strings.Repeat("é", 200) + `"… (1 more characters not shown)?`},
		{"spaces too", strings.Repeat(" ", 3000), `"` + strings.Repeat(" ", 200) + `"… (2800 more characters not shown)?`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reg, _, _, _ := newSettingsRegistry(t)
			_, err := reg.Invoke(context.Background(), page, "settings.set", map[string]string{"key": "projects.branch_prefix", "value": tc.value})
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || !strings.HasSuffix(ce.Message, tc.want) {
				t.Errorf("err = %#v, want a message ending %q", err, tc.want)
			}
		})
	}
}

// A page's dialog quotes the value, so a value cannot draw lines of its own in it, and a
// mistyped key is the page's error, not a question to the user.
func TestSettingChangeDialog(t *testing.T) {
	page := command.Context{ActiveThreadID: "s-1", Origin: command.OriginPage}
	reg, _, _, _ := newSettingsRegistry(t)
	_, err := reg.Invoke(context.Background(), page, "settings.set", map[string]string{"key": "projects.branch_prefix", "value": "x\n\nsecond line"})
	var ce *command.ConfirmError
	if !errors.As(err, &ce) || strings.Contains(ce.Message, "\n") || !strings.Contains(ce.Message, `"x\n\nsecond line"`) {
		t.Errorf("err = %#v", err)
	}
	_, err = reg.Invoke(context.Background(), page, "settings.set", map[string]string{"key": "nope.nope", "value": "1"})
	if errors.As(err, &ce) || !errors.Is(err, command.ErrInvalidArgs) {
		t.Errorf("unknown key: %v", err)
	}
}

// settings.get says which settings are the user's, and asking does not need --yes.
func TestSettingUserOnlyListed(t *testing.T) {
	reg, _, _, _ := newSettingsRegistry(t)
	res, err := reg.Invoke(context.Background(), command.Context{ActiveThreadID: "s-1"}, "settings.get", map[string]string{"key": "advanced.claude_path"})
	if err != nil {
		t.Fatal(err)
	}
	if js, _ := res.EncodeJSON(); !strings.Contains(js, `"userOnly":true`) {
		t.Errorf("json %s", js)
	}
	for _, name := range []string{"settings.set", "settings.reset"} {
		if c, ok := reg.Get(name); !ok || c.Confirm != "" {
			t.Errorf("%s has a Confirm: its --yes would reach every agent's help", name)
		}
	}
}
