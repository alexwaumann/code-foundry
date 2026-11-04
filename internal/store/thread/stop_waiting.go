package thread

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
)

// Stop waiting (docs/notes/wait-list-daemon.md): the user takes back a thread that would
// otherwise be woken. Everything that would wake it goes, in one step: its subscriptions
// of every kind (a repeat one too), the wakes already queued or held for it, and its
// background shells. It only stops listening: its child threads keep working, and its
// subagents run to their end (nothing can stop one run), so a thread with subagents
// stays waiting on them.

// StopWaitingResult is what StopWaiting did.
type StopWaitingResult struct {
	// Thread is the thread after its wakes went (its shells stop in the background).
	Thread Thread
	// Removed are its subscriptions, and the held wakes left of its one-shots.
	Removed []Subscription
	// Shells are the background shells it is stopping.
	Shells []BackgroundShell
}

// StopWaiting implements Store. A resident thread refuses: what wakes it is its board.
// The wakes go first: a shell that cannot be stopped (an
// error naming it, for every such shell) leaves them gone. A shell that ended meanwhile
// is not an error. Stopping a shell at the prompt can still wake Claude to report it
// (bgshells_runner.go), as thread.shell.stop does.
func (m *Manager) StopWaiting(ctx context.Context, id string) (StopWaitingResult, error) {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return StopWaitingResult{}, m.notFound(id)
	}
	if t.Kind == KindResident {
		return StopWaitingResult{}, fmt.Errorf("%w: thread %s is the resident %s thread: its wakes and timers run its board and nothing would bring them back; remove one with thread unsubscribe <id>",
			ErrFailedPrecondition, id, t.ResidentName)
	}
	out := StopWaitingResult{Removed: m.subs.dropWakes(id)}
	m.rewait(id)
	m.log.Info("stopped waiting", "thread", id, "subscriptions", len(out.Removed), "shells", len(t.BackgroundShells))
	var errs []error
	for _, sh := range t.BackgroundShells {
		switch _, err := m.StopShell(ctx, id, sh.TaskID); {
		case err == nil:
			out.Shells = append(out.Shells, sh)
		case !errors.Is(err, ErrNotFound):
			errs = append(errs, fmt.Errorf("stop background shell %s: %w", sh.TaskID, err))
		}
	}
	out.Thread, _ = m.Snapshot().Thread(id)
	return out, errors.Join(errs...)
}

// dropWakes removes every subscription of subscriber and takes back the wakes on their
// way to it and held for it, and returns them in listing order. That reaches a wake
// waiting out its batch window: only one whose Send started is past stopping. Wakes held
// about subscriber, to its own subscribers, stay.
func (s *subscriptions) dropWakes(subscriber string) []Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.dropWakesLocked(subscriber, nil)
	seen := map[string]bool{}
	for _, sub := range out {
		seen[sub.ID] = true
	}
	for _, r := range s.byID {
		if r.s.SubscriberID == subscriber && !seen[r.s.ID] {
			seen[r.s.ID] = true
			out = append(out, r.s)
		}
	}
	for id, h := range s.heldOnlyLocked(subscriber) {
		if !seen[id] {
			seen[id] = true
			out = append(out, h)
		}
	}
	sortSubscriptions(out)
	if len(out) == 0 {
		return nil
	}
	s.removeLocked(slices.Collect(maps.Keys(seen)))
	s.changedLocked(subscriber) // removeLocked tells only of the ones it kept
	return out
}

// onTheWayLocked are the subscriptions of the wakes on their way to subscriber, queued or
// taken by the drain. Callers hold s.mu.
func (s *subscriptions) onTheWayLocked(subscriber string) []Subscription {
	q := s.queues[subscriber]
	if q == nil {
		return nil
	}
	var out []Subscription
	for _, d := range q.items {
		if d.of.ID != "" {
			out = append(out, d.of)
		}
	}
	for _, of := range q.taken {
		if of.ID != "" {
			out = append(out, of)
		}
	}
	return out
}

// dropWakesLocked takes back wakes on their way, queued or taken by the drain: subscriber's
// ("": every thread's), of subscriptions ids (nil: all of them). It returns their
// subscriptions as they fired, each once; a one-shot that fired has no other record. A
// restart's notice is taken back only by a stop (ids nil). Callers hold s.mu.
func (s *subscriptions) dropWakesLocked(subscriber string, ids []string) []Subscription {
	hit := func(sub string) bool { return ids == nil || slices.Contains(ids, sub) }
	found := map[string]Subscription{}
	note := func(sub Subscription) {
		if sub.ID != "" {
			found[sub.ID] = sub
		}
	}
	for owner, q := range s.queues {
		if subscriber != "" && owner != subscriber {
			continue
		}
		q.items = slices.DeleteFunc(q.items, func(d delivery) bool {
			if !hit(d.sub) {
				return false
			}
			note(d.of)
			return true
		})
		for sub, of := range q.taken {
			if !hit(sub) {
				continue
			}
			note(of)
			if q.dropped == nil {
				q.dropped = map[string]bool{}
			}
			q.dropped[sub] = true
		}
	}
	return slices.Collect(maps.Values(found))
}
