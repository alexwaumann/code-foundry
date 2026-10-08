package command_test

import (
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/command"
)

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
