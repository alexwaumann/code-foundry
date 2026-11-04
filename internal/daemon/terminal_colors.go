package daemon

import (
	"context"
	"strconv"

	"github.com/alexwaumann/code-foundry/internal/store/terminal"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// terminalColors is what a theme tells programs in a terminal about its colours: the
// slots the GUI paints its terminals with (gui/frontend/src/terminal/theme.ts).
func terminalColors(f theme.Frame) terminal.Colors {
	return terminal.Colors{
		Foreground: slotRGB(f, "--terminal-fg"),
		Background: slotRGB(f, "--cf-surface"),
		Cursor:     slotRGB(f, "--terminal-cursor"),
	}
}

// slotRGB reads a slot's colour. theme.Frame.Check allows only #rrggbb and #rrggbbaa; a
// program asking for a colour gets no alpha.
func slotRGB(f theme.Frame, name string) terminal.RGB {
	v := f.Vars[name]
	if len(v) < 7 {
		return terminal.RGB{}
	}
	n, err := strconv.ParseUint(v[1:7], 16, 32)
	if err != nil {
		return terminal.RGB{}
	}
	return terminal.RGB{R: uint8(n >> 16), G: uint8(n >> 8), B: uint8(n)}
}

// publishTerminalColors gives terminals each theme the GUI publishes.
func publishTerminalColors(t *terminal.Manager) func(context.Context, theme.Frame) {
	return func(ctx context.Context, f theme.Frame) { t.SetColors(ctx, terminalColors(f)) }
}
