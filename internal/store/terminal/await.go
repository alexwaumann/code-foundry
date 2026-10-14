package terminal

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// AwaitOutput returns once terminal id has printed something and then been quiet for
// `quiet` (a shell's first output is usually its prompt; a startup file printing ahead
// of it gets the quiet period). Input written before that is echoed by the PTY's line
// discipline before the shell's line editor takes over, so the line shows twice
// (docs/notes/bottom-panel-autoshell.md); terminal.new --run waits with this first.
//
// It fails with ctx's error when ctx ends first, with ErrExited when the process exits
// before printing, and with ErrSlowSubscriber when its subscription is dropped. It works
// on any Store.
func AwaitOutput(ctx context.Context, s Store, id string, quiet time.Duration) error {
	actx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Attach before looking at the screen, so output cannot slip between the two.
	events, err := s.Attach(actx, id)
	if err != nil {
		return fmt.Errorf("await output of terminal %s: %w", id, err)
	}
	quietTimer := time.NewTimer(quiet)
	quietTimer.Stop()
	defer quietTimer.Stop()
	seen := false
	printed := func() {
		seen = true
		quietTimer.Reset(quiet)
	}
	if text, err := s.ScreenText(ctx, id); err == nil && strings.TrimSpace(text) != "" {
		printed()
	}
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("await output of terminal %s: %w", id, ctx.Err())
		case <-quietTimer.C:
			return nil
		case ev, ok := <-events:
			switch {
			case !ok:
				if ctx.Err() != nil {
					return fmt.Errorf("await output of terminal %s: %w", id, ctx.Err())
				}
				return fmt.Errorf("await output of terminal %s: %w", id, ErrNotFound)
			case ev.Dropped:
				return fmt.Errorf("await output of terminal %s: %w", id, ErrSlowSubscriber)
			case ev.Exited != nil:
				if seen {
					return nil
				}
				return fmt.Errorf("await output of terminal %s: %w", id, ErrExited)
			case len(ev.Output) > 0:
				printed()
			}
		}
	}
}
