package terminal

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// closePoll is how often KillAndRemove re-reads the terminal while it waits for the
// exit, in case the Watch subscription dropped the event (the bus never blocks).
const closePoll = 250 * time.Millisecond

// KillAndRemove kills terminal id (SIGHUP, then SIGKILL after the store's grace period,
// exactly like Store.Kill), waits for it to exit, and removes it. It works on any Store.
// A terminal that is removed by someone else meanwhile (the daemon removes exited
// shells itself) counts as done. It fails with ErrNotFound when id does not exist, and
// with ctx's error if the process has not exited when ctx ends.
func KillAndRemove(ctx context.Context, s Store, id string) error {
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Subscribe before killing, so the exit cannot slip between Kill and the wait.
	events, err := s.Watch(wctx)
	if err != nil {
		return fmt.Errorf("close terminal %s: %w", id, err)
	}
	if err := s.Kill(ctx, id); err != nil {
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
			if err := KillAndRemove(ctx, s, t.ID); err != nil && !errors.Is(err, ErrNotFound) {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	return n, errors.Join(errs...)
}
