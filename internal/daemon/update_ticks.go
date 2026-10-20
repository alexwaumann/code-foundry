package daemon

import (
	"context"
	"os"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// updateTick is how often the fallback loop compares the wall clock with the interval
// (see update.Store's loop for why not a plain timer).
const updateTick = time.Minute

// onUpdateChecks runs check whenever the app's updater has checked for a release (an
// update.Event with a new LastCheckedAt: hourly, docs/notes/update-check-hourly.md). A
// build whose updater is disabled (a dev build) runs check on the same cadence by
// itself: after update.DefaultInitialDelay (or $CODE_FOUNDRY_UPDATE_DELAY),
// then every update.DefaultInterval. The plugin and skill registries ride it. stop
// waits for a check in flight.
func onUpdateChecks(ctx context.Context, b *bus.Bus, u update.Service, check func(ctx context.Context)) (stop func()) {
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	if u.Snapshot().Enabled {
		sub := bus.Subscribe[update.Event](b, 16)
		wg.Go(func() {
			defer sub.Close()
			var last time.Time
			for {
				select {
				case <-ctx.Done():
					return
				case ev, ok := <-sub.C():
					if !ok {
						return
					}
					if at := ev.Status.LastCheckedAt; !at.IsZero() && !at.Equal(last) {
						last = at
						check(ctx)
					}
				}
			}
		})
	} else {
		delay := update.DefaultInitialDelay
		if d, err := time.ParseDuration(os.Getenv(update.EnvInitialDelay)); err == nil && d >= 0 {
			delay = d
		}
		wg.Go(func() {
			initial := time.NewTimer(delay)
			defer initial.Stop()
			tick := time.NewTicker(updateTick)
			defer tick.Stop()
			var last time.Time
			for {
				select {
				case <-ctx.Done():
					return
				case <-initial.C:
				case <-tick.C:
					if last.IsZero() || time.Now().Round(0).Sub(last) < update.DefaultInterval {
						continue
					}
				}
				check(ctx)
				last = time.Now().Round(0)
			}
		})
	}
	return func() {
		cancel()
		wg.Wait()
	}
}
