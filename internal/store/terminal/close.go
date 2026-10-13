package terminal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/termlabel"
)

// closePoll is how often KillAndRemove re-reads the terminal while it waits for the
// exit, in case the Watch subscription dropped the event (the bus never blocks).
const closePoll = 250 * time.Millisecond

// ErrNotShell is returned by CloseShell for a terminal terminal.new did not start (one
// TerminalService.Create made without labels).
var ErrNotShell = errors.New("not a shell terminal")

// CloseShell is KillAndRemove for a shell terminal.new started (termlabel.KindShell). It
// refuses any other terminal with ErrNotShell (terminal.kill and terminal.remove end
// those). It fails with ErrNotFound when id does not exist.
func CloseShell(ctx context.Context, s Store, id string) error {
	t, err := s.Get(ctx, id)
	if err != nil {
		return fmt.Errorf("close terminal %s: %w", id, err)
	}
	if !termlabel.IsShell(t.Labels) {
		return fmt.Errorf("close terminal %s: %w", id, ErrNotShell)
	}
	return KillAndRemove(ctx, s, id)
}

// KillAndRemove kills terminal id (SIGHUP, then SIGKILL after the store's grace period,
// exactly like Store.Kill), waits for it to exit, and removes it. It works on any Store.
// A terminal that is gone already, or removed by someone else meanwhile (the daemon
// removes exited shells itself), counts as done: an id that does not exist is not an
// error. It fails with ctx's error if the process has not exited when ctx ends.
func KillAndRemove(ctx context.Context, s Store, id string) error {
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Subscribe before killing, so the exit cannot slip between Kill and the wait.
	events, err := s.Watch(wctx)
	if err != nil {
		return fmt.Errorf("close terminal %s: %w", id, err)
	}
	if err := s.Kill(ctx, id); errors.Is(err, ErrNotFound) {
		return nil // exited and removed just before (or never existed)
	} else if err != nil {
		return fmt.Errorf("close terminal %s: %w", id, err)
	}
	tick := time.NewTicker(closePoll)
	defer tick.Stop()
	for {
		t, err := s.Get(ctx, id)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("close terminal %s: %w", id, err)
		}
		if t.State == StateExited {
			break
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("close terminal %s: waiting for exit: %w", id, ctx.Err())
		case _, ok := <-events:
			if !ok {
				events = nil // ended with ctx; the next pass sees ctx.Done
			}
		case <-tick.C:
		}
	}
	if err := s.Remove(ctx, id); err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("close terminal %s: %w", id, err)
	}
	return nil
}

// KillAndRemoveWhere runs KillAndRemove, concurrently, on every terminal that match
// selects, and returns their errors joined. It returns how many terminals matched.
func KillAndRemoveWhere(ctx context.Context, s Store, match func(Terminal) bool) (int, error) {
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		errs []error
		n    int
	)
	for _, t := range s.List(ctx) {
		if !match(t) {
			continue
		}
		n++
		wg.Go(func() {
			if err := KillAndRemove(ctx, s, t.ID); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	return n, errors.Join(errs...)
}
