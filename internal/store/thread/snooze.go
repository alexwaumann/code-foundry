package thread

import (
	"context"
	"fmt"
	"time"
)

// ReasonSnoozeEnded is the StatusReason, with StatusNeedsAttention, of a thread whose
// snooze ran out (wakeSnoozed). Like "finished" on a disconnected thread it lasts until
// a reconnect hands the status to the new process.
const ReasonSnoozeEnded = "snooze ended"

// SnoozeCheckInterval is how often a running Manager compares the wall clock with the
// snoozed threads' SnoozedUntil (Options.SnoozeCheckInterval's default).
const SnoozeCheckInterval = 30 * time.Second

// Snooze snoozes a thread until a time, or unsnoozes it (until zero)
// (docs/notes/snooze-threads-1-daemon.md).
//
// Snoozing closes the thread like Close (a no-op when it is disconnected), kills and
// removes its shells like Remove, then, under m.mu, unpins and unarchives it and sets
// SnoozedUntil (replacing an earlier snooze). until must be after Options.Now. As with
// Archive, a Reconnect that wins the race between the close and that last step makes
// Snooze fail rather than snooze a live thread. Unsnoozing only clears SnoozedUntil:
// the thread stays disconnected and gets no attention.
func (m *Manager) Snooze(ctx context.Context, id string, until time.Time) (Thread, error) {
	if until.IsZero() {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Thread{}, err
		}
		if m.unsnoozeLocked(rec) {
			m.commitLocked(rec, true)
			m.log.Info("unsnoozed thread", "thread", id)
		}
		return rec.s, nil
	}
	// Wall clock only (see wakeSnoozed); persisted at millisecond precision.
	until = until.Round(0).Truncate(time.Millisecond)
	if !until.After(m.opts.Now()) {
		return Thread{}, fmt.Errorf("%w: snooze time %s is not in the future", ErrInvalidArgument, until.Format(time.RFC3339))
	}
	if err := m.Close(ctx, id); err != nil {
		return Thread{}, err
	}
	if err := m.removeShells(ctx, id); err != nil {
		return Thread{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	if rec.run != nil || rec.s.State != StateDisconnected {
		return Thread{}, fmt.Errorf("%w: thread %s was started while being snoozed", ErrFailedPrecondition, id)
	}
	rec.s.SnoozedUntil = until
	rec.s.Pinned = false
	m.unarchiveLocked(rec)
	m.commitLocked(rec, true)
	m.log.Info("snoozed thread", "thread", id, "until", until)
	return rec.s, nil
}

// unsnoozeLocked clears rec's SnoozedUntil and reports whether it was set, so the
// caller commits. Reconnect, Pin(true), Send and Archive(true) unsnooze implicitly, at
// the same spots that unarchive. Callers hold m.mu.
func (m *Manager) unsnoozeLocked(rec *record) bool {
	if rec.s.SnoozedUntil.IsZero() {
		return false
	}
	rec.s.SnoozedUntil = time.Time{}
	return true
}

// wakeSnoozed wakes every thread whose SnoozedUntil is not after Options.Now: it
// clears SnoozedUntil and, for a disconnected thread (every snoozed thread is one;
// Reconnect unsnoozes), sets StatusNeedsAttention ReasonSnoozeEnded stamped with the
// wake time, persisted and published. The status is stamped even when it already
// reads "snooze ended" (a re-snoozed thread that was never reconnected), so the GUI's
// "ended … ago" counts from this wake.
//
// It compares wall-clock times on purpose: SnoozedUntil carries no monotonic reading
// (Snooze strips it, the database and the API have none), and Go's monotonic clock
// stops while the Mac sleeps, so a single timer set for the snooze would fire late by
// the time slept. New calls it once (snoozes that ended while the daemon was stopped),
// then wakeSnoozedLoop every Options.SnoozeCheckInterval.
func (m *Manager) wakeSnoozed() {
	now := m.opts.Now().Round(0)
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, rec := range m.recs {
		if rec.s.SnoozedUntil.IsZero() || rec.s.SnoozedUntil.After(now) {
			continue
		}
		until := rec.s.SnoozedUntil
		rec.s.SnoozedUntil = time.Time{}
		if rec.run == nil && rec.s.State == StateDisconnected {
			rec.s.Status, rec.s.StatusReason, rec.s.StatusChangedAt = StatusNeedsAttention, ReasonSnoozeEnded, now
		}
		m.commitLocked(rec, true)
		m.log.Info("snooze ended", "thread", id, "until", until, "late", now.Sub(until).Round(time.Second))
	}
}

// wakeSnoozedLoop runs wakeSnoozed on every tick until Shutdown cancels m.ctx.
func (m *Manager) wakeSnoozedLoop(tick <-chan time.Time) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-tick:
			m.wakeSnoozed()
		}
	}
}
