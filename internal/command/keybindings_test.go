package command_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/awaumann/code-foundry/internal/command"
)

// reservedChords are chords command keybindings must never use. Keep in sync with:
//   - viewActions in gui/frontend/src/keys/bindings.ts: GUI-local actions that win
//     over any command, even in a focused terminal (a command bound there never fires);
//   - editingChords in gui/frontend/src/keys/chord.ts: clipboard/undo, always left to
//     the focused terminal or text field;
//   - cmd+w and cmd+q, which the Wails app menu takes (close window, quit).
//
// See docs/notes/phase1e-gui.md and docs/notes/phase2-integration.md.
var reservedChords = []string{
	// viewActions
	"cmd+k", "cmd+shift+p", "cmd+b", "cmd+shift+a",
	"cmd+1", "cmd+2", "cmd+3", "cmd+4", "cmd+5", "cmd+6", "cmd+7", "cmd+8", "cmd+9",
	"cmd+=", "cmd+-", "cmd+0",
	// editingChords
	"cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z",
	// app menu
	"cmd+w", "cmd+q",
}

// normalizeChord mirrors the frontend's normalizeChord closely enough for comparison:
// lower case, modifier aliases folded, modifiers in a fixed order, key last.
func normalizeChord(s string) string {
	alias := map[string]string{
		"meta": "cmd", "command": "cmd", "⌘": "cmd",
		"control": "ctrl", "⌃": "ctrl",
		"opt": "alt", "option": "alt", "⌥": "alt",
		"⇧": "shift",
	}
	order := []string{"cmd", "ctrl", "alt", "shift"}
	parts := strings.Split(strings.ToLower(strings.TrimSpace(s)), "+")
	key := parts[len(parts)-1]
	var mods []string
	for _, p := range parts[:len(parts)-1] {
		if a, ok := alias[p]; ok {
			p = a
		}
		if !slices.Contains(mods, p) {
			mods = append(mods, p)
		}
	}
	slices.SortFunc(mods, func(a, b string) int { return slices.Index(order, a) - slices.Index(order, b) })
	return strings.Join(append(mods, key), "+")
}

func TestKeybindingsAreUniqueAndNotReserved(t *testing.T) {
	f := newFixture(t)
	owner := map[string]string{} // normalized chord -> command
	for _, l := range f.reg.List(command.Context{}, true) {
		for _, k := range l.Command.Keybindings {
			chord := normalizeChord(k)
			if slices.Contains(reservedChords, chord) {
				t.Errorf("%s binds reserved chord %q", l.Command.Name, k)
			}
			if prev, ok := owner[chord]; ok {
				t.Errorf("%s and %s both bind %q", prev, l.Command.Name, chord)
			}
			owner[chord] = l.Command.Name
		}
	}
}

// The chords the GUI (phase 2c) expects on the session commands.
func TestSessionKeybindings(t *testing.T) {
	f := newFixture(t)
	want := map[string]string{
		"session.new":       "cmd+n",
		"session.rename":    "cmd+r",
		"session.reconnect": "cmd+shift+r",
		"session.close":     "cmd+shift+w",
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
	tests := []struct{ in, want string }{
		{"cmd+k", "cmd+k"},
		{"Shift+Cmd+W", "cmd+shift+w"},
		{"meta+alt+r", "cmd+alt+r"},
		{"option+command+r", "cmd+alt+r"},
		{"cmd+=", "cmd+="},
		{"f2", "f2"},
	}
	for _, tt := range tests {
		if got := normalizeChord(tt.in); got != tt.want {
			t.Errorf("normalizeChord(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
