package daemon

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// notificationThreadSweep is how often the glue withdraws notifications whose thread is
// gone, for a removal whose event the bus dropped.
const notificationThreadSweep = time.Minute

// notificationThreads is the part of the notification store the glue drives.
// *notification.Manager implements it.
type notificationThreads interface {
	ThreadGone(ctx context.Context, id string) (int, error)
	WithdrawMissingThreads(ctx context.Context, exists func(string) bool) (int, error)
}

// threadExists reports whether the thread store has a thread (a removed one is gone; an
// archived one exists).
func threadExists(snap func() *thread.Snapshot) func(string) bool {
	return func(id string) bool {
		_, ok := snap().Thread(id)
		return ok
	}
}

// startNotificationThreads withdraws a removed thread's notifications (thread.Removed),
// and sweeps at start and every minute for any whose thread is gone. An archived thread
// keeps its notifications: they stay in the bell, which is where the user finds it
// (docs/notes/notifications-1-store.md). The returned func stops it.
func startNotificationThreads(ctx context.Context, log *slog.Logger, store notificationThreads, threads func() *thread.Snapshot, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[thread.Event](b, 256)
	exists := threadExists(threads)
	sweep := func() {
		if _, err := store.WithdrawMissingThreads(ctx, exists); err != nil {
			log.Warn("notifications of removed threads not withdrawn", "err", err)
		}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		tick := time.NewTicker(notificationThreadSweep)
		defer tick.Stop()
		sweep()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				sweep()
			case ev := <-events.C():
				if e, ok := ev.(thread.Removed); ok {
					if _, err := store.ThreadGone(ctx, e.ID); err != nil {
						log.Warn("notifications of a removed thread not withdrawn", "thread", e.ID, "err", err)
					}
				}
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
