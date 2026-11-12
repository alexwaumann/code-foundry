package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

// The commands the settings page offers no keybinding for: CLI queries that print, a
// wait, and verbs the CLI uses to drive the GUI. A new command is bindable unless it is
// added here (docs/notes/settings-pages-schema.md).
func TestNoKeybindingCommands(t *testing.T) {
	f := newFixture(t)
	want := []string{
		"action.last", "action.list", "action.runs", "action.stop", "action.wait",
		"app.version", "composer.stage", "daemon.capabilities", "daemon.status", "daemon.version",
		"dictation.hold", "dictation.start", "dictation.status", "dictation.stop",
		"ember.status", "ember.board", "ember.remember", "ember.reseed", "ember.enable", "ember.disable", "ember.task.add", "ember.task.update", "ember.task.done", "ember.task.start", "ember.task.cancel", "ember.task.list", "ember.task.show",
		"file.export", "memory.show", "memory.add", "memory.remove", "memory.clear",
		"plugin.act", "plugin.browse", "plugin.env", "plugin.list", "plugin.logs", "plugin.new", "plugin.reload", "plugin.secrets.list", "plugin.surface", "plugin.terminals", "plugin.threads", "plugin.wakes",
		"pr.checks", "project.list",
		"search.agent", "search.clear", "search.find", "search.forget", "search.get", "search.open-hit", "search.promote", "search.recent", "search.report", "search.seen", "search.stop",
		"settings.get", "settings.path", "settings.reset", "settings.set",
		"skill.browse",
		"terminal.list", "theme.check", "theme.list", "theme.restore", "theme.save", "theme.show",
		"thread.agent.open", "thread.agents", "thread.ask", "thread.checkouts", "thread.commands", "thread.focus", "thread.get", "thread.items", "thread.list", "thread.mcp", "thread.move.open", "thread.new-like", "thread.placement.check", "thread.prompts", "thread.search", "thread.read", "thread.report", "thread.reports", "thread.reseed", "thread.respond", "thread.setup.cancel", "thread.setup.discard", "thread.setup.retry", "thread.shell.stop", "thread.stop-waiting",
		"thread.subscribe", "thread.subscriptions", "thread.unsubscribe", "thread.wait", "thread.flags", "thread.flag.clear",
		"ui.focus.project", "ui.focus.terminal", "ui.notify", "ui.palette.open", "ui.presence",
		"usage.show", "view.inline", "view.open.url", "view.panel.diff", "view.panel.file", "view.panel.gallery", "view.panel.page", "view.panel.pr",
		"workspace.list", "worktree.editors",
		"layout.show", "pane.focus", "pane.move", "pane.resize", "space.list", "space.move", "space.rename", "space.switch", "tab.focus", "tab.list", "tab.move", "thread.open", "thread.space.move",
		"composer.draft.clear", "composer.draft.discard", "composer.draft.label", "composer.draft.open", "composer.draft.start",
	}
	var got []string
	for _, l := range f.reg.List(command.Context{}, true) {
		if l.NoKeybinding {
			got = append(got, l.Name)
		}
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Errorf("NoKeybinding commands = %v, want %v", got, want)
	}
}

// sharedRoot is the command whose chord name shares (SharedChords), or name itself: two
// commands may bind one chord only when they share it with the same command.
func sharedRoot(name string) string {
	if root, ok := command.SharedChords[name]; ok {
		return root
	}
	return name
}

func TestKeybindingsAreUniqueAndNotReserved(t *testing.T) {
	f := newFixture(t)
	owner := map[string]string{} // normalized chord -> command
	for _, l := range f.reg.List(command.Context{}, true) {
		for _, k := range l.Command.Keybindings {
			chord, err := command.NormalizeChord(k)
			if err != nil {
				t.Errorf("%s binds unparsable chord %q: %v", l.Command.Name, k, err)
			}
			if slices.Contains(command.ReservedChords, chord) {
				t.Errorf("%s binds reserved chord %q", l.Command.Name, k)
			}
			if prev, ok := owner[chord]; ok && sharedRoot(prev) != sharedRoot(l.Command.Name) {
				t.Errorf("%s and %s both bind %q", prev, l.Command.Name, chord)
			}
			owner[chord] = l.Command.Name
		}
	}
}

// A shared chord is the same chord on both commands: the GUI resolves it by where the
// keyboard is, and a command it names must exist.
func TestSharedChordsMatch(t *testing.T) {
	f := newFixture(t)
	for name, other := range command.SharedChords {
		a, ok := f.reg.Get(name)
		b, okOther := f.reg.Get(other)
		if !ok || !okOther {
			t.Fatalf("%s or %s is not registered", name, other)
		}
		if !slices.Equal(a.Keybindings, b.Keybindings) {
			t.Errorf("%s keybindings = %v, %s has %v", name, a.Keybindings, other, b.Keybindings)
		}
	}
}

// The chords the GUI expects on the panel toggles. cmd+j is the bottom panel's, like
// VS Code's panel; it must stay free of GUI view actions (ReservedChords).
func TestPanelKeybindings(t *testing.T) {
	f := newFixture(t)
	want := map[string]string{
		"view.panel.toggle":  "cmd+shift+e",
		"view.bottom.toggle": "cmd+j",
		"terminal.new":       "cmd+t",
		"view.thread-info":   "cmd+shift+i",
	}
	for name, chord := range want {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if !slices.Equal(c.Keybindings, []string{chord}) {
			t.Errorf("%s keybindings = %v, want [%s]", name, c.Keybindings, chord)
		}
		if slices.Contains(command.ReservedChords, chord) {
			t.Errorf("%s binds reserved chord %s", name, chord)
		}
	}
}

// Back and forward through the window's selection history: a browser's and Finder's
// chords; previous and next thread in sidebar order. Commands, not GUI view actions, so they stay unreserved and rebindable.
func TestHistoryKeybindings(t *testing.T) {
	f := newFixture(t)
	tests := []struct{ name, title, chord string }{
		{name: "view.back", title: "Back", chord: "cmd+["},
		{name: "view.forward", title: "Forward", chord: "cmd+]"},
		// The positional companions: macOS tab switching (Safari, Terminal).
		{name: "thread.previous", title: "Previous Thread", chord: "cmd+shift+["},
		{name: "thread.next", title: "Next Thread", chord: "cmd+shift+]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, ok := f.reg.Get(tt.name)
			if !ok {
				t.Fatalf("%s not registered", tt.name)
			}
			if c.Title != tt.title || c.Category != "View" {
				t.Errorf("%s title, category = %q, %q; want %q, View", tt.name, c.Title, c.Category, tt.title)
			}
			if !slices.Equal(c.Keybindings, []string{tt.chord}) {
				t.Errorf("%s keybindings = %v, want [%s]", tt.name, c.Keybindings, tt.chord)
			}
			if got, err := command.ValidateBinding(tt.chord); err != nil || got != tt.chord {
				t.Errorf("ValidateBinding(%q) = %q, %v; want it bindable", tt.chord, got, err)
			}
		})
	}
}

// The chords the GUI (phase 2c) expects on the thread commands.
func TestThreadKeybindings(t *testing.T) {
	f := newFixture(t)
	want := map[string]string{
		"thread.new":    "cmd+n",
		"thread.rename": "cmd+r",
	}
	for name, chord := range want {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if !slices.Contains(c.Keybindings, chord) {
			t.Errorf("%s keybindings = %v, want %s", name, c.Keybindings, chord)
		}
	}
}

func TestNormalizeChord(t *testing.T) {
	tests := []struct{ in, want, err string }{
		{in: "cmd+k", want: "cmd+k"},
		{in: "Shift+Cmd+W", want: "cmd+shift+w"},
		{in: "meta+alt+r", want: "cmd+alt+r"},
		{in: "option+command+r", want: "cmd+alt+r"},
		{in: "cmd+=", want: "cmd+="},
		{in: "cmd++", want: "cmd+="},
		{in: "cmd+/", want: "cmd+/"},
		{in: "cmd+comma", want: "cmd+,"},
		{in: "f2", want: "f2"},
		{in: "ctrl+esc", want: "ctrl+escape"},
		{in: "", err: "empty chord"},
		{in: "hyper+k", err: `unknown modifier "hyper"`},
		{in: "cmd+", err: `unknown key ""`},
		{in: "cmd+π", err: `unknown key "π"`},
	}
	for _, tt := range tests {
		got, err := command.NormalizeChord(tt.in)
		if tt.err != "" {
			if err == nil || err.Error() != tt.err {
				t.Errorf("NormalizeChord(%q) err = %v, want %q", tt.in, err, tt.err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("NormalizeChord(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
}

func TestValidateBinding(t *testing.T) {
	tests := []struct{ in, want, err string }{
		{in: "cmd+shift+n", want: "cmd+shift+n"},
		{in: "ctrl+alt+t", want: "ctrl+alt+t"},
		{in: "f5", want: "f5"},
		{in: "shift+f5", want: "shift+f5"},
		{in: "Cmd+K", err: "cmd+k is reserved by the app"},
		{in: "cmd+shift+a", err: "cmd+shift+a is reserved by the app"},
		{in: "cmd+w", err: "cmd+w is reserved by the app"},
		// The side panel's other-group chord; view.panel.split's cmd+\ is bindable.
		{in: `alt+cmd+\`, err: `cmd+alt+\ is reserved by the app`},
		{in: `cmd+\`, want: `cmd+\`},
		{in: "ctrl+cmd+f", err: "cmd+ctrl+f is reserved by the app"},
		{in: "f", err: "f needs cmd, ctrl, or alt (a bare key would steal typing)"},
		{in: "shift+x", err: "shift+x needs cmd, ctrl, or alt (a bare key would steal typing)"},
		{in: "cmd+nope", err: `unknown key "nope"`},
	}
	for _, tt := range tests {
		got, err := command.ValidateBinding(tt.in)
		if tt.err != "" {
			if err == nil || err.Error() != tt.err {
				t.Errorf("ValidateBinding(%q) err = %v, want %q", tt.in, err, tt.err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("ValidateBinding(%q) = %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
}
