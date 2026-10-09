package command

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Keybindings use the GUI's chord syntax (gui/frontend/src/keys/chord.ts): modifiers
// cmd, ctrl, alt, shift (aliases meta/command/⌘, control/⌃, opt/option/⌥, ⇧) joined
// with "+", then one key. The canonical form orders modifiers cmd, ctrl, alt, shift.

// ReservedChords are canonical chords no command may bind. Keep in sync with:
//   - viewActions in gui/frontend/src/keys/bindings.ts: GUI-local actions that win over
//     any command, even in a focused terminal (a command bound there never fires);
//   - editingChords in gui/frontend/src/keys/chord.ts: clipboard/undo, always left to
//     the focused terminal or text field;
//   - the Wails app menu (gui/app.go appMenu): quit, hide, hide others, minimize, full
//     screen;
//   - cmd+w: the side panel's "close the active tab" (gui/frontend/src/components/panel).
//     The app menu's Close Window has no key equivalent, so cmd+w never closes the
//     window, but no command may bind it either.
//
// See docs/notes/phase1e-gui.md and docs/notes/phase2-integration.md.
var ReservedChords = []string{
	// viewActions
	"cmd+k", "cmd+shift+p", "cmd+b", "cmd+shift+a",
	"cmd+1", "cmd+2", "cmd+3", "cmd+4", "cmd+5", "cmd+6", "cmd+7", "cmd+8", "cmd+9",
	"cmd+=", "cmd+-", "cmd+0",
	// editingChords
	"cmd+c", "cmd+v", "cmd+x", "cmd+a", "cmd+z", "cmd+shift+z",
	// side panel (close tab)
	"cmd+w",
	// app menu
	"cmd+q", "cmd+h", "cmd+alt+h", "cmd+m", "cmd+ctrl+f",
}

var chordModifiers = map[string]string{
	"cmd": "cmd", "meta": "cmd", "command": "cmd", "super": "cmd", "⌘": "cmd",
	"ctrl": "ctrl", "control": "ctrl", "⌃": "ctrl",
	"alt": "alt", "opt": "alt", "option": "alt", "⌥": "alt",
	"shift": "shift", "⇧": "shift",
}

var chordModifierOrder = []string{"cmd", "ctrl", "alt", "shift"}

var chordKeyAliases = map[string]string{
	"esc": "escape", "return": "enter", "del": "delete",
	"up": "arrowup", "down": "arrowdown", "left": "arrowleft", "right": "arrowright",
	"plus": "=", "minus": "-", "comma": ",", "period": ".", "slash": "/", "spacebar": "space",
}

// chordKeyPattern is the keys the GUI can match: a letter or digit, a named key, f1-f12,
// or punctuation (see chord.ts eventKey).
var chordKeyPattern = regexp.MustCompile("^([a-z0-9]|enter|escape|tab|space|backspace|delete|" +
	"arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|f([1-9]|1[0-2])|[,./=\\-\\[\\];'`\\\\])$")

var functionKey = regexp.MustCompile(`^f([1-9]|1[0-2])$`)

// NormalizeChord returns the canonical form of a chord ("Shift+Cmd+W" -> "cmd+shift+w")
// or an error if it does not parse or names a key the GUI cannot match.
func NormalizeChord(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "", fmt.Errorf("empty chord")
	}
	var parts []string
	if strings.HasSuffix(s, "++") { // "cmd++" is cmd and the "+" key
		parts = append(strings.Split(strings.TrimSuffix(s, "++"), "+"), "+")
	} else {
		parts = strings.Split(s, "+")
	}
	key := strings.TrimSpace(parts[len(parts)-1])
	if a, ok := chordKeyAliases[key]; ok {
		key = a
	}
	if key == "+" {
		key = "=" // the + key is shift+= on a US layout; the GUI matches physical keys
	}
	if !chordKeyPattern.MatchString(key) {
		return "", fmt.Errorf("unknown key %q", key)
	}
	var mods []string
	for _, p := range parts[:len(parts)-1] {
		m, ok := chordModifiers[strings.TrimSpace(p)]
		if !ok {
			return "", fmt.Errorf("unknown modifier %q", p)
		}
		if !slices.Contains(mods, m) {
			mods = append(mods, m)
		}
	}
	slices.SortFunc(mods, func(a, b string) int {
		return slices.Index(chordModifierOrder, a) - slices.Index(chordModifierOrder, b)
	})
	return strings.Join(append(mods, key), "+"), nil
}

// ValidateBinding checks that s is a chord a command may bind: it parses, is not
// reserved, and has a modifier unless it is a function key (bare letters would steal
// typing from every list and form).
func ValidateBinding(s string) (string, error) {
	c, err := NormalizeChord(s)
	if err != nil {
		return "", err
	}
	if slices.Contains(ReservedChords, c) {
		return "", fmt.Errorf("%s is reserved by the app", c)
	}
	bare := strings.TrimPrefix(c, "shift+")
	if !strings.Contains(bare, "+") && !functionKey.MatchString(bare) {
		return "", fmt.Errorf("%s needs cmd, ctrl, or alt (a bare key would steal typing)", c)
	}
	return c, nil
}
