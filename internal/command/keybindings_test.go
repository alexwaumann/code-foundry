package command_test

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
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
		"thread.agent.open", "thread.agents", "thread.ask", "thread.checkouts", "thread.commands", "thread.focus", "thread.get", "thread.info", "thread.items", "thread.list", "thread.mcp", "thread.move.open", "thread.new-like", "thread.placement.check", "thread.prompts", "thread.search", "thread.read", "thread.report", "thread.reports", "thread.reseed", "thread.respond", "thread.setup.cancel", "thread.setup.discard", "thread.setup.retry", "thread.shell.stop", "thread.stop-waiting",
		"thread.subscribe", "thread.subscriptions", "thread.unsubscribe", "thread.wait", "thread.flags", "thread.flag.clear",
		"ui.focus.project", "ui.focus.terminal", "ui.notify", "ui.palette.open", "ui.presence",
		"usage.show", "view.inline", "view.open.diff", "view.open.file", "view.open.gallery", "view.open.page", "view.open.pr", "view.open.url",
		"view.panel.diff", "view.panel.file", "view.panel.gallery", "view.panel.page", "view.panel.pr",
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

// specKeyRows reads the key table of docs/notes/shell-model.md ("Keys"): each row's Key cell
// and Does cell.
func specKeyRows(t *testing.T) [][2]string {
	t.Helper()
	b, err := os.ReadFile("../../docs/notes/shell-model.md")
	if err != nil {
		t.Fatal(err)
	}
	md := string(b)
	i := strings.Index(md, "\n## Keys\n")
	if i < 0 {
		t.Fatal("shell-model.md has no Keys section")
	}
	section := md[i+1:]
	if j := strings.Index(section[1:], "\n## "); j >= 0 {
		section = section[:j+1]
	}
	var rows [][2]string
	for _, line := range strings.Split(section, "\n") {
		if !strings.HasPrefix(line, "| ") || strings.HasPrefix(line, "| Key") || strings.HasPrefix(line, "| ---") {
			continue
		}
		cells := strings.Split(line, "|")
		rows = append(rows, [2]string{strings.TrimSpace(cells[1]), strings.TrimSpace(cells[2])})
	}
	return rows
}

// specChords expands a Key cell: "a / b" is two chords, "ctrl+cmd+h j k l, ctrl+cmd+arrows"
// the four letters and the four arrows, "cmd+1…9" nine chords.
func specChords(cell string) []string {
	var out []string
	for _, part := range regexp.MustCompile(` / |, `).Split(cell, -1) {
		switch {
		case regexp.MustCompile(`^(.*\+)([a-z])((?: [a-z])+)$`).MatchString(part):
			m := regexp.MustCompile(`^(.*\+)([a-z])((?: [a-z])+)$`).FindStringSubmatch(part)
			for _, k := range append([]string{m[2]}, strings.Fields(m[3])...) {
				out = append(out, m[1]+k)
			}
		case strings.HasSuffix(part, "+arrows"):
			for _, a := range []string{"left", "down", "up", "right"} {
				out = append(out, strings.TrimSuffix(part, "arrows")+a)
			}
		case strings.HasSuffix(part, "+1…9"):
			for d := 1; d <= 9; d++ {
				out = append(out, strings.TrimSuffix(part, "1…9")+strconv.Itoa(d))
			}
		default:
			out = append(out, part)
		}
	}
	return out
}

// view is a row's chords that are GUI view actions (ReservedChords), not registry commands.
const view = "(view action)"

// The spec's key table (docs/notes/shell-model.md, "Keys") is the keymap: each row's chords,
// in its order, are the default chords of these commands (a row of several verbs spreads its
// chords over them in turn), or GUI view actions, which are reserved. The GUI's half
// (gui/frontend/src/keys/shellKeys.test.ts) checks the same table reaches the same verbs.
func TestShellKeyTable(t *testing.T) {
	want := map[string][]string{
		"cmd+n":                             {"thread.new"},
		"cmd+t":                             {"terminal.new"},
		"cmd+shift+t":                       {"tab.reopen"},
		"cmd+j":                             {"terminal.quick"},
		"cmd+shift+j":                       {"terminal.cycle"},
		"cmd+shift+d":                       {"view.thread-diff"},
		"cmd+shift+i":                       {"view.thread-info"},
		"cmd+p":                             {"file.find"},
		"cmd+k":                             {view},
		"cmd+w":                             {"tab.close"},
		"cmd+shift+w":                       {"pane.close"},
		"cmd+[ / cmd+]":                     {"view.back", "view.forward"},
		"cmd+shift+[ / cmd+shift+]":         {"tab.previous", "tab.next"},
		"ctrl+cmd+h j k l, ctrl+cmd+arrows": {"pane.focus.left", "pane.focus.down", "pane.focus.up", "pane.focus.right"},
		"ctrl+cmd+1…9":                      {view},
		"cmd+1…9":                           {view},
		"cmd+shift+enter":                   {"pane.fullscreen"},
		"cmd+shift+m":                       {"pane.collapse"},
		"cmd+shift+a":                       {view},
		"cmd+r":                             {"tab.rename"},
		"cmd+shift+r":                       {"tab.auto-name"},
		"cmd+b":                             {view},
	}
	f := newFixture(t)
	owner := map[string]string{}
	for _, l := range f.reg.List(command.Context{}, true) {
		for _, k := range l.Command.Keybindings {
			c, _ := command.NormalizeChord(k)
			owner[c] = l.Command.Name
		}
	}
	rows := specKeyRows(t)
	if len(rows) != len(want) {
		t.Errorf("the spec's table has %d rows, this test %d", len(rows), len(want))
	}
	for _, row := range rows {
		verbs, ok := want[row[0]]
		if !ok {
			t.Errorf("spec row %q is not in this test", row[0])
			continue
		}
		chords := specChords(row[0])
		for i, ch := range chords {
			c, err := command.NormalizeChord(ch)
			if err != nil {
				t.Errorf("row %q: chord %q: %v", row[0], ch, err)
				continue
			}
			verb := verbs[i%len(verbs)]
			if verb == view {
				if !slices.Contains(command.ReservedChords, c) {
					t.Errorf("row %q: %s is a view action but not reserved", row[0], c)
				}
				if owner[c] != "" {
					t.Errorf("row %q: %s is a view action but %s binds it", row[0], c, owner[c])
				}
				continue
			}
			if owner[c] != verb {
				t.Errorf("row %q: %s runs %q, want %q", row[0], c, owner[c], verb)
			}
		}
		// "with shift, move the pane": the same chords with shift move the pane that way.
		if strings.Contains(row[1], "with shift, move the pane") {
			for i, ch := range chords {
				c, _ := command.NormalizeChord(strings.Replace(ch, "cmd+", "cmd+shift+", 1))
				if w := strings.Replace(verbs[i%len(verbs)], "pane.focus.", "pane.move.", 1); owner[c] != w {
					t.Errorf("row %q: %s runs %q, want %q", row[0], c, owner[c], w)
				}
			}
		}
	}
}

// The chords the spec retires (docs/notes/shell-model.md, "Keys") are bound to nothing and
// not reserved: free for a user's own binding. The pages they opened keep no chord.
func TestRetiredChords(t *testing.T) {
	f := newFixture(t)
	retired := map[string]string{
		"cmd+shift+e": "the side panel",
		`cmd+\`:       "the panel split",
		`cmd+alt+\`:   "the split panel's other group",
	}
	for _, l := range f.reg.List(command.Context{}, true) {
		for _, k := range l.Command.Keybindings {
			c, _ := command.NormalizeChord(k)
			if what, ok := retired[c]; ok {
				t.Errorf("%s binds %s, retired with %s", l.Command.Name, c, what)
			}
		}
	}
	for c := range retired {
		if got, err := command.ValidateBinding(c); err != nil || got != c {
			t.Errorf("ValidateBinding(%q) = %q, %v; want it free", c, got, err)
		}
	}
	for _, name := range []string{"view.pullrequests", "view.projects", "thread.previous", "thread.next", "thread.rename"} {
		c, ok := f.reg.Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if len(c.Keybindings) != 0 {
			t.Errorf("%s keybindings = %v, want none", name, c.Keybindings)
		}
	}
	// The side and bottom panel verbs went with their panels (docs/notes/shell-22-retire-verbs.md):
	// a chord can name none of them.
	for _, name := range []string{"view.panel.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split", "view.bottom.toggle"} {
		if _, ok := f.reg.Get(name); ok {
			t.Errorf("%s is still registered", name)
		}
	}
}

// Back and forward through what was focused: a browser's and Finder's chords; the previous
// and next tab in the pane: macOS tab switching (Safari, Terminal). Commands, not GUI view
// actions, so they stay unreserved and rebindable.
func TestHistoryKeybindings(t *testing.T) {
	f := newFixture(t)
	tests := []struct{ name, title, category, chord string }{
		{name: "view.back", title: "Back", category: "View", chord: "cmd+["},
		{name: "view.forward", title: "Forward", category: "View", chord: "cmd+]"},
		{name: "tab.previous", title: "Previous Tab", category: "Layout", chord: "cmd+shift+["},
		{name: "tab.next", title: "Next Tab", category: "Layout", chord: "cmd+shift+]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, ok := f.reg.Get(tt.name)
			if !ok {
				t.Fatalf("%s not registered", tt.name)
			}
			if c.Title != tt.title || c.Category != tt.category {
				t.Errorf("%s title, category = %q, %q; want %q, %s", tt.name, c.Title, c.Category, tt.title, tt.category)
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
		// tab.close's default since the shell: bindable, no longer the side panel's.
		{in: "cmd+w", want: "cmd+w"},
		// Retired with the side panel's split (shell-model.md, "Keys").
		{in: `alt+cmd+\`, want: `cmd+alt+\`},
		{in: `cmd+\`, want: `cmd+\`},
		// The space chords are GUI view actions.
		{in: "ctrl+cmd+3", err: "cmd+ctrl+3 is reserved by the app"},
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
