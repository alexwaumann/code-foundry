package daemon

import (
	"context"
	"log/slog"
	"sync"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A thread's request for the user's eyes (thread.look; docs/notes/waiting-thread-look.md) is
// a notification under SourceCommand with the key notification.LookKey(thread). It goes:
//
//   - when the user sees the thread (the thread store's seen hook, as an until-seen flag);
//   - when the thread's status turns to needs attention (a turn ended Done, or it asks a
//     question or a permission): the thread is in Needs you then, which the user sees anyway;
//   - when the user dismisses it, the thread withdraws it (thread look --withdraw), or the
//     thread is removed (the notification store's own rules).
//
// Withdrawn, not dismissed, so the thread asking again later with the same words shows again.

// lookNotes is the part of the notification store the look glue uses. *notification.Manager
// implements it.
type lookNotes interface {
	Active(source, key string) (notification.Notification, bool)
	Withdraw(ctx context.Context, source, key string) (notification.Notification, error)
}

// withdrawLook withdraws thread id's request to look when one is active, and says whether
// it did.
func withdrawLook(ctx context.Context, log *slog.Logger, notes lookNotes, id, why string) bool {
	key := notification.LookKey(id)
	if _, ok := notes.Active(notification.SourceCommand, key); !ok {
		return false
	}
	if _, err := notes.Withdraw(ctx, notification.SourceCommand, key); err != nil {
		log.Warn("a thread's request to look not withdrawn", "thread", id, "why", why, "err", err)
		return false
	}
	log.Debug("a thread's request to look withdrawn", "thread", id, "why", why)
	return true
}

// lookStatus follows each thread's status and reports the ones that just turned to needs
// attention. Not safe for concurrent use: the glue's goroutine owns it.
type lookStatus map[string]thread.Status

// seed records the statuses in snap.
func (l lookStatus) seed(snap *thread.Snapshot) {
	if snap == nil {
		return
	}
	for _, t := range snap.Threads {
		l[t.ID] = t.Status
	}
}

// turnedAttention records t's status and reports whether it just turned to needs
// attention. A thread first heard of already needing attention has turned.
func (l lookStatus) turnedAttention(t thread.Thread) bool {
	prev, known := l[t.ID]
	l[t.ID] = t.Status
	return t.Status == thread.StatusNeedsAttention && (!known || prev != thread.StatusNeedsAttention)
}

// startThreadLook withdraws threads' requests to look when the user sees the thread or it
// turns to needs attention. The returned func stops it.
func startThreadLook(ctx context.Context, log *slog.Logger, threads seenHooks, snap func() *thread.Snapshot, notes lookNotes, b *bus.Bus) func() {
	unhook := threads.AddSeenHook(func(id string) {
		// Called with the thread store's lock held; the notification store never waits on it.
		withdrawLook(context.Background(), log, notes, id, "seen")
	})
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[thread.Event](b, 256)
	status := lookStatus{}
	status.seed(snap())
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-events.C():
				switch e := ev.(type) {
				case thread.Updated:
					if status.turnedAttention(e.Thread) {
						withdrawLook(ctx, log, notes, e.Thread.ID, "needs attention")
					}
				case thread.Removed:
					delete(status, e.ID)
				}
			}
		}
	})
	return func() {
		unhook()
		cancel()
		wg.Wait()
	}
}
