package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/all"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// A settings file written for the classic window (docs/notes/shell-20-cutover.md) keeps
// working with the shell's keymap: an override that names a command that is gone (the side and
// bottom panel verbs, docs/notes/shell-22-retire-verbs.md), or whose chord is now another
// command's default, is reported as an issue and dropped, the command it collides with keeps
// its chord, and the rest of the file applies. Nothing is fatal.
func TestStaleKeybindingOverrides(t *testing.T) {
	reg := command.NewRegistry()
	if err := all.Register(reg, all.Deps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), settings.FileName)
	file := `[keybindings]
"view.bottom.toggle" = "cmd+j"
"thread.previous" = "cmd+shift+["
"view.pullrequests" = "cmd+shift+w"
"view.panel.gone" = "cmd+y"
"view.panel.toggle" = "cmd+shift+e"
"view.panel.expand" = "cmd+shift+x"
"view.panel.new-tab" = "cmd+shift+n"
"view.panel.split" = "cmd+\\"
"view.help" = "cmd+alt+\\"
"thread.rename" = "f2+cmd"
"view.projects" = "cmd+ctrl+1"
"view.usage" = "cmd+shift+k"
`
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := settings.Open(context.Background(), settings.Options{Path: path, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatalf("a stale keybindings table must not stop the settings: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	applySettings(st, reg, new(slog.LevelVar), false)

	issues := map[string]string{}
	for _, is := range st.Snapshot().Issues {
		issues[strings.TrimPrefix(is.Key, "keybindings.")] = is.Message
	}
	wantIssue := map[string]string{
		"view.bottom.toggle": `unknown command "view.bottom.toggle"`,
		"view.panel.toggle":  `unknown command "view.panel.toggle"`,
		"view.panel.expand":  `unknown command "view.panel.expand"`,
		"view.panel.new-tab": `unknown command "view.panel.new-tab"`,
		"view.panel.split":   `unknown command "view.panel.split"`,
		"thread.previous":    "cmd+shift+[ is already bound to tab.previous",
		"view.pullrequests":  "cmd+shift+w is already bound to pane.close",
		"view.panel.gone":    `unknown command "view.panel.gone"`,
		"thread.rename":      "unknown key",
		"view.projects":      "cmd+ctrl+1 is reserved by the app",
	}
	for name, want := range wantIssue {
		if got, ok := issues[name]; !ok || !strings.Contains(got, want) {
			t.Errorf("%s: issue %q, want one containing %q (issues: %v)", name, got, want, issues)
		}
	}
	for _, name := range []string{"view.help", "view.usage"} {
		if msg, ok := issues[name]; ok {
			t.Errorf("%s: unexpected issue %q", name, msg)
		}
	}

	chords := func(name string) []string {
		c, ok := reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		return c.Keybindings
	}
	for name, want := range map[string][]string{
		// The new defaults win over a stale override.
		"terminal.quick": {"cmd+j"},
		"tab.previous":   {"cmd+shift+["},
		"pane.close":     {"cmd+shift+w"},
		// Rejected overrides leave the command on its own default (none, since the shell).
		"thread.previous":   nil,
		"view.pullrequests": nil,
		"view.projects":     nil,
		// A free retired chord may be bound again; an unrelated override applies.
		"view.help":  {"cmd+alt+\\"},
		"view.usage": {"cmd+shift+k"},
	} {
		if got := chords(name); !slices.Equal(got, want) && (len(got) != 0 || len(want) != 0) {
			t.Errorf("%s keybindings = %v, want %v", name, got, want)
		}
	}
}

// The chords that became defaults with docs/notes/put-away-chords.md were the user's to bind
// before (cmd+shift+n and cmd+shift+s free, cmd+shift+a reserved and refused): an override
// that already names one keeps it, and the new default's command goes without that chord (its
// value reads "none"), with no issue: nothing in the file is ignored. Nothing ends up on two
// commands.
func TestPutAwayChordsKeepUserOverrides(t *testing.T) {
	reg := command.NewRegistry()
	if err := all.Register(reg, all.Deps{Emitter: &commandtest.Emitter{}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), settings.FileName)
	file := `[keybindings]
"thread.new" = "cmd+shift+n"
"view.usage" = "cmd+shift+a"
"thread.pin" = "cmd+shift+s"
`
	if err := os.WriteFile(path, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := settings.Open(context.Background(), settings.Options{Path: path, Log: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	applySettings(st, reg, new(slog.LevelVar), false)

	if is := st.Snapshot().Issues; len(is) != 0 {
		t.Errorf("issues = %v, want none", is)
	}
	for _, name := range []string{"thread.needs.next", "thread.archive", "thread.snooze.default"} {
		if v := st.Snapshot().Values[settings.KeybindingKey(name)]; v != settings.KeybindingNone {
			t.Errorf("%s value = %q, want none", name, v)
		}
	}
	owners := map[string][]string{}
	for _, l := range reg.List(command.Context{}, true) {
		for _, k := range l.Command.Keybindings {
			owners[k] = append(owners[k], l.Command.Name)
		}
	}
	for chord, want := range map[string]string{"cmd+shift+n": "thread.new", "cmd+shift+a": "view.usage", "cmd+shift+s": "thread.pin"} {
		if got := owners[chord]; !slices.Equal(got, []string{want}) {
			t.Errorf("%s runs %v, want only %s", chord, got, want)
		}
	}
	// The file keeps the user's lines as they were, and gains nothing for the yielded ones.
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != file {
		t.Errorf("settings file =\n%s\nwant it untouched", b)
	}
	// Binding the yielded command to a chord of its own takes it back.
	if _, err := st.Update(context.Background(), map[string]string{"keybindings.thread.needs.next": "cmd+alt+n"}); err != nil {
		t.Fatal(err)
	}
	if c, _ := reg.Get("thread.needs.next"); !slices.Equal(c.Keybindings, []string{"cmd+alt+n"}) {
		t.Errorf("thread.needs.next keybindings = %v after its own override", c.Keybindings)
	}
	if v := st.Snapshot().Values[settings.KeybindingKey("thread.needs.next")]; v != "cmd+alt+n" {
		t.Errorf("thread.needs.next value = %q after its own override", v)
	}
}
