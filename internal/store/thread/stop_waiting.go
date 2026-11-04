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

// StopWaiting implements Store. The wakes go first: a shell that cannot be stopped (an
// error naming it, for every such shell) leaves them gone. A shell that ended meanwhile
// is not an error. Stopping a shell at the prompt can still wake Claude to report it
// (bgshells_runner.go), as thread.shell.stop does.
func (m *Manager) StopWaiting(ctx context.Context, id string) (StopWaitingResult, error) {
	t, ok := m.Snapshot().Thread(id)
	if !ok {
		return StopWaitingResult{}, m.notFound(id)
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

// dropWakes removes every subscription of subscriber and the wakes queued or held for
// it, and returns the subscriptions in listing order. A wake being delivered right now
// is past this point. Wakes held about subscriber, to its own subscribers, stay.
func (s *subscriptions) dropWakes(subscriber string) []Subscription {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Subscription
	for _, r := range s.byID {
		if r.s.SubscriberID == subscriber {
			out = append(out, r.s)
		}
	}
	out = slices.AppendSeq(out, maps.Values(s.heldOnlyLocked(subscriber)))
	sortSubscriptions(out)
	if q, ok := s.queues[subscriber]; ok {
		q.items = nil
	}
	if len(out) == 0 {
		return nil
	}
	ids := make([]string, len(out))
	for i, sub := range out {
		ids[i] = sub.ID
	}
	s.removeLocked(ids)
	s.changedLocked(subscriber) // removeLocked tells only of the ones it kept
	return out
}
