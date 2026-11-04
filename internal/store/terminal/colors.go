package terminal

import (
	"context"
	"errors"
	"maps"
	"slices"

	ghostty "go.mitchellh.com/libghostty"
)

// RGB is one colour.
type RGB struct{ R, G, B uint8 }

// Colors are the default colours the emulator reports to programs that ask (OSC 10, 11
// and 12). They only answer queries: the attached GUI does the painting.
type Colors struct {
	Foreground RGB
	Background RGB
	Cursor     RGB
}

// SetColors makes c the colours of new terminals and of every terminal already running.
// Without them the emulator leaves OSC 10/11/12 unanswered. The answer has to come from
// here: a program sends OSC 11 and then a cursor position query as a sentinel, and takes
// the sentinel's reply arriving first to mean the terminal has no answer. Anything later
// than the emulator's own reply reaches the shell as typed text.
func (m *Manager) SetColors(ctx context.Context, c Colors) {
	m.colors.Store(&c)
	m.mu.RLock()
	actors := slices.Collect(maps.Values(m.actors))
	m.mu.RUnlock()
	for _, a := range actors {
		m.applyColors(ctx, a)
	}
}

// applyColors gives a the current colours, read on the actor so that the last SetColors
// wins whatever order concurrent calls reach it.
func (m *Manager) applyColors(ctx context.Context, a *actor) {
	err := a.call(ctx, func() { a.setColors(m.colors.Load()) })
	if err != nil && !errors.Is(err, ErrNotFound) {
		a.log.Warn("set terminal colors", "err", err)
	}
}

// setColors runs on the actor. An override a program set (OSC 11 with a colour) stays in
// front of these until it resets it, as in any terminal.
func (a *actor) setColors(c *Colors) {
	if c == nil {
		return
	}
	if err := setVTColors(a.vt, *c); err != nil {
		a.log.Warn("set terminal colors", "err", err)
	}
}

// setVTColors gives t its default colors. Call only on t's owning goroutine.
func setVTColors(t *ghostty.Terminal, c Colors) error {
	return errors.Join(
		t.SetColorForeground(ghosttyRGB(c.Foreground)),
		t.SetColorBackground(ghosttyRGB(c.Background)),
		t.SetColorCursor(ghosttyRGB(c.Cursor)),
	)
}

func ghosttyRGB(c RGB) *ghostty.ColorRGB { return &ghostty.ColorRGB{R: c.R, G: c.G, B: c.B} }
