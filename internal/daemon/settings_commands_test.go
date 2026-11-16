package daemon

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// A plugin's commands registering after the daemon applied settings (plugins start
// last) make their keybinding overrides settable and applied; removing them reports
// the override again without dropping it.
func TestSettingsCommandHost(t *testing.T) {
	st := openSettings(t)
	reg := command.NewRegistry()
	noop := func(context.Context, command.Context, command.Args) (command.Result, error) {
		return command.Result{}, nil
	}
	if err := reg.Register(command.Command{Name: "thread.new", Title: "New Thread", Category: "Thread", Keybindings: []string{"cmd+n"}, Run: noop}); err != nil {
		t.Fatal(err)
	}
	applySettings(st, reg, new(slog.LevelVar), false)
	host := settingsCommandHost{Registry: reg, settings: st}
	key := settings.KeybindingKey("plugin.minimal.hello")
	hello := []command.Command{{Name: "plugin.minimal.hello", Title: "Hello", Category: "Minimal", Run: noop}}
	keysOf := func() []string {
		c, _ := reg.Get("plugin.minimal.hello")
		return c.Keybindings
	}

	steps := []struct {
		name      string
		cmds      []command.Command // ReplacePrefix("plugin.minimal.", cmds) before the step
		set       bool              // settings set <key> cmd+shift+y
		wantErr   bool
		wantKeys  []string
		wantIssue bool
	}{
		{name: "plugin not started: refused", set: true, wantErr: true},
		{name: "plugin registers: set applies", cmds: hello, set: true, wantKeys: []string{"cmd+shift+y"}},
		{name: "plugin disabled: kept as an issue", cmds: []command.Command{}, wantIssue: true},
		{name: "plugin back: applies again", cmds: hello, wantKeys: []string{"cmd+shift+y"}},
	}
	for _, s := range steps {
		if s.cmds != nil {
			if err := host.ReplacePrefix("plugin.minimal.", s.cmds); err != nil {
				t.Fatalf("%s: ReplacePrefix: %v", s.name, err)
			}
		}
		if s.set {
			_, err := st.Update(context.Background(), map[string]string{key: "cmd+shift+y"})
			var ve *settings.ValidationError
			if s.wantErr != errors.As(err, &ve) {
				t.Fatalf("%s: Update err = %v", s.name, err)
			}
		}
		if got := keysOf(); len(s.wantKeys) > 0 && (len(got) != 1 || got[0] != s.wantKeys[0]) {
			t.Errorf("%s: registry keybindings = %v, want %v", s.name, got, s.wantKeys)
		}
		hasIssue := false
		for _, is := range st.Snapshot().Issues {
			hasIssue = hasIssue || is.Key == key
		}
		if hasIssue != s.wantIssue {
			t.Errorf("%s: issues = %v", s.name, st.Snapshot().Issues)
		}
	}
}

// Resetting a command's keybinding puts it back on its default chord, in the settings
// page's field, the snapshot, the file and the registry, also after a plugin's commands
// came (the plugin store starts after settings apply, so the registry already holds the
// overrides then). Until the settings store was given the registry's overridden chords
// as defaults: an unbound command's default became nothing and its reset left it
// unbound; a rebound one's default became its override, with no reset to offer.
func TestKeybindingResetAfterPluginStart(t *testing.T) {
	noop := func(context.Context, command.Context, command.Args) (command.Result, error) {
		return command.Result{}, nil
	}
	const open, other = "demo.open", "demo.other"
	openKey, otherKey := settings.KeybindingKey(open), settings.KeybindingKey(other)
	tests := []struct {
		name      string
		file      string // the [keybindings] table's lines
		reset     string // the key the page resets
		wantPage  map[string]string
		wantAfter map[string]string   // values after the reset
		wantReg   map[string][]string // registry chords after the reset
		wantIssue map[string]string   // issues after the reset
		wantFile  []string            // lines the file keeps
		notFile   []string            // lines it leaves out
	}{
		{
			name: "unbound", file: `"demo.open" = "none"`, reset: openKey,
			wantPage:  map[string]string{openKey: "cmd+t"},
			wantAfter: map[string]string{openKey: "cmd+t", otherKey: "cmd+o"},
			wantReg:   map[string][]string{open: {"cmd+t"}, other: {"cmd+o"}},
			notFile:   []string{`"demo.open" =`},
		},
		{
			name: "rebound", file: `"demo.open" = "cmd+y"`, reset: openKey,
			wantPage:  map[string]string{openKey: "cmd+t"},
			wantAfter: map[string]string{openKey: "cmd+t"},
			wantReg:   map[string][]string{open: {"cmd+t"}},
			notFile:   []string{`"demo.open" =`},
		},
		{
			name: "its default held by another override", file: "\"demo.open\" = \"none\"\n\"demo.other\" = \"cmd+t\"", reset: openKey,
			wantPage:  map[string]string{openKey: "cmd+t", otherKey: "cmd+o"},
			wantAfter: map[string]string{openKey: "cmd+t", otherKey: "cmd+o"},
			wantReg:   map[string][]string{open: {"cmd+t"}, other: {"cmd+o"}},
			wantIssue: map[string]string{otherKey: "cmd+t is already bound to demo.open"},
			wantFile:  []string{`"demo.other" = "cmd+t"`},
			notFile:   []string{`"demo.open" =`},
		},
		{
			name: "the other one reset", file: "\"demo.open\" = \"none\"\n\"demo.other\" = \"cmd+t\"", reset: otherKey,
			wantPage:  map[string]string{openKey: "cmd+t", otherKey: "cmd+o"},
			wantAfter: map[string]string{openKey: "none", otherKey: "cmd+o"},
			wantReg:   map[string][]string{open: {}, other: {"cmd+o"}},
			wantFile:  []string{`"demo.open" = "none"`},
			notFile:   []string{`"demo.other" =`},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			if err := reg.RegisterAll(
				// Unavailable without a thread, like terminal.new: its default still counts.
				command.Command{Name: open, Title: "Open", Category: "Demo", Keybindings: []string{"cmd+t"}, Run: noop,
					When: func(c command.Context) bool { return c.ActiveThreadID != "" }},
				command.Command{Name: other, Title: "Other", Category: "Demo", Keybindings: []string{"cmd+o"}, Run: noop},
			); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), settings.FileName)
			if err := os.WriteFile(path, []byte("[keybindings]\n"+tt.file+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			st, err := settings.Open(context.Background(), settings.Options{Path: path, Log: slog.New(slog.DiscardHandler)})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = st.Close() })
			applySettings(st, reg, new(slog.LevelVar), false)
			host := settingsCommandHost{Registry: reg, settings: st}
			if err := host.ReplacePrefix("plugin.minimal.", nil); err != nil {
				t.Fatal(err)
			}

			defaults := map[string]string{}
			for _, f := range st.Fields() {
				defaults[f.Key] = f.Default
			}
			for k, want := range tt.wantPage {
				if defaults[k] != want {
					t.Errorf("before the reset: %s default = %q, want %q", k, defaults[k], want)
				}
			}

			if _, err := st.Update(context.Background(), map[string]string{tt.reset: ""}); err != nil {
				t.Fatalf("reset: %v", err)
			}
			snap := st.Snapshot()
			for k, want := range tt.wantAfter {
				if got := snap.Values[k]; got != want {
					t.Errorf("after the reset: %s = %q, want %q", k, got, want)
				}
			}
			for name, want := range tt.wantReg {
				if c, _ := reg.Get(name); !slices.Equal(c.Keybindings, want) {
					t.Errorf("after the reset: registry %s = %v, want %v", name, c.Keybindings, want)
				}
			}
			issues := map[string]string{}
			for _, is := range snap.Issues {
				issues[is.Key] = is.Message
			}
			if !maps.Equal(issues, tt.wantIssue) && len(issues)+len(tt.wantIssue) > 0 {
				t.Errorf("issues = %v, want %v", issues, tt.wantIssue)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, l := range tt.wantFile {
				if !strings.Contains(string(data), "\n"+l) {
					t.Errorf("the file lost %s", l)
				}
			}
			for _, l := range tt.notFile {
				if strings.Contains(string(data), "\n"+l) {
					t.Errorf("the file still has %s", l)
				}
			}
		})
	}
}
