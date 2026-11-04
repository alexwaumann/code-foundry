package threadtest

import (
	"context"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// StopWaiting records "StopWaiting <id>", refuses a resident thread, drops the thread's subscriptions and shells and
// publishes thread.SubscriptionsChanged, as the store does.
func (f *Fake) StopWaiting(_ context.Context, id string) (thread.StopWaitingResult, error) {
	var out thread.StopWaitingResult
	t, err := f.mutate(fmt.Sprintf("StopWaiting %s", id), id, func(s *thread.Thread) error {
		if s.Kind == thread.KindResident {
			return fmt.Errorf("%w: thread %s is the resident %s thread", thread.ErrFailedPrecondition, id, s.ResidentName)
		}
		out.Shells = s.BackgroundShells
		s.BackgroundShells, s.BackgroundShellsRunning = nil, 0
		return nil
	})
	if err != nil {
		return thread.StopWaitingResult{}, err
	}
	out.Thread = t
	f.mu.Lock()
	var left []thread.Subscription
	for _, sub := range f.subs {
		if sub.SubscriberID == id {
			out.Removed = append(out.Removed, sub)
		} else {
			left = append(left, sub)
		}
	}
	f.subs = slices.Clip(left)
	f.mu.Unlock()
	bus.Publish(f.bus, thread.SubscriptionsChanged{SubscriberID: id})
	return out, nil
}
