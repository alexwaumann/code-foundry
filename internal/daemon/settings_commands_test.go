package daemon

import (
	"context"
	"errors"
	"log/slog"
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
