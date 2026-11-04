package daemon

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

func TestTerminalColors(t *testing.T) {
	tests := []struct {
		name string
		vars map[string]string
		want terminal.Colors
	}{
		{
			name: "the slots the GUI paints with",
			vars: map[string]string{"--cf-surface": "#21252b", "--terminal-fg": "#ABB2BF", "--terminal-cursor": "#528bff"},
			want: terminal.Colors{
				Foreground: terminal.RGB{R: 0xab, G: 0xb2, B: 0xbf},
				Background: terminal.RGB{R: 0x21, G: 0x25, B: 0x2b},
				Cursor:     terminal.RGB{R: 0x52, G: 0x8b, B: 0xff},
			},
		},
		{
			name: "alpha is dropped",
			vars: map[string]string{"--cf-surface": "#21252b80"},
			want: terminal.Colors{Background: terminal.RGB{R: 0x21, G: 0x25, B: 0x2b}},
		},
		{name: "a missing or unreadable slot is black", vars: map[string]string{"--cf-surface": "#21252", "--terminal-fg": "#zzzzzz"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := terminalColors(theme.Frame{Vars: tt.vars}); got != tt.want {
				t.Errorf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}

// The defaults carry every slot terminalColors reads, so nothing is black by accident.
func TestTerminalColorsDefaults(t *testing.T) {
	for _, scheme := range []string{theme.SchemeDark, theme.SchemeLight} {
		c := terminalColors(theme.DefaultFrame(scheme))
		if c.Foreground == (terminal.RGB{}) || c.Cursor == (terminal.RGB{}) || c.Foreground == c.Background {
			t.Errorf("%s: %+v", scheme, c)
		}
	}
}
