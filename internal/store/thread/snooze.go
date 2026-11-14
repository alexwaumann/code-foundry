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

// Snoozed reports whether the thread is put away until a time or saved for later, the
// two forms of a snooze. Use SnoozedUntil only for the wake time itself.
func (s Thread) Snoozed() bool { return !s.SnoozedUntil.IsZero() || !s.SavedAt.IsZero() }

// Snooze snoozes a thread until a time, or unsnoozes it (until zero)
// (docs/notes/snooze-threads-1-daemon.md).
//
// Snoozing closes the thread like Close (a no-op when it is disconnected), kills and
// removes its shells like Remove, then, under m.mu, unpins and unarchives it and sets
// SnoozedUntil (replacing an earlier snooze, or a save for later). until must be after
// Options.Now. As with Archive, a turn the close cut off leaves the thread idle
// ReasonSnoozed instead of error ReasonInterrupted, and a start that wins the race
// between the close and that last step makes Snooze fail rather than snooze a live
// thread. Unsnoozing only clears SnoozedUntil and SavedAt: the thread stays disconnected
// and gets no attention.
func (m *Manager) Snooze(ctx context.Context, id string, until time.Time) (Thread, error) {
	return m.snooze(ctx, id, until, nil)
}

// snooze is Snooze; closing as in archive.
func (m *Manager) snooze(ctx context.Context, id string, until time.Time, closing *runner) (Thread, error) {
	if until.IsZero() {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Thread{}, err
		}
		m.dropPutAwayLocked(rec, "the thread was unsnoozed")
		if m.unsnoozeLocked(rec) {
			m.commitLocked(rec, true)
			m.log.Info("unsnoozed thread", "thread", id)
		}
		return rec.s, nil
	}
	until, err := m.snoozeTime(until)
	if err != nil {
		return Thread{}, err
	}
	s, err := m.putAway(ctx, id, closing, func(s *Thread) {
		s.SnoozedUntil, s.SavedAt = until, time.Time{}
	})
	if err != nil {
		return Thread{}, err
	}
	m.log.Info("snoozed thread", "thread", id, "until", until)
	return s, nil
}

// SaveForLater snoozes a thread with no wake time
// (docs/notes/save-for-later-1-daemon.md): what Snooze does, except that it stamps
// SavedAt (kept on a thread already saved, so saving twice does not reorder the list)
// and clears SnoozedUntil, so wakeSnoozed never sees it. It lasts until a call that
// unsnoozes.
func (m *Manager) SaveForLater(ctx context.Context, id string) (Thread, error) {
	return m.saveForLater(ctx, id, nil)
}

// saveForLater is SaveForLater; closing as in archive.
func (m *Manager) saveForLater(ctx context.Context, id string, closing *runner) (Thread, error) {
	s, err := m.putAway(ctx, id, closing, func(s *Thread) {
		s.SnoozedUntil = time.Time{}
		if s.SavedAt.IsZero() {
			s.SavedAt = m.opts.Now().Round(0).Truncate(time.Millisecond)
		}
	})
	if err != nil {
		return Thread{}, err
	}
	m.log.Info("saved thread for later", "thread", id)
	return s, nil
}

// putAway is the part of a snooze both forms share: it closes the thread, removes its
// shells, then under m.mu applies set, unpins and unarchives it and clears a "snooze
// ended" status. A turn the close cut off reads idle ReasonSnoozed (markPuttingAway).
func (m *Manager) putAway(ctx context.Context, id string, closing *runner, set func(*Thread)) (_ Thread, err error) {
	if err := m.refuseResident(id, "snoozed"); err != nil {
		return Thread{}, err
	}
	if err := m.refuseSettingUp(id, "snoozed"); err != nil {
		return Thread{}, err
	}
	wasInterrupted, err := m.interrupted(id)
	if err != nil {
		return Thread{}, err
	}
	m.markPuttingAway(id, wasInterrupted, ReasonSnoozed)
	defer func() { m.endPuttingAway(id, err != nil) }() // after m.mu's unlock below
	if err := m.closeAway(ctx, id, closing); err != nil {
		return Thread{}, err
	}
	if err := m.removeShells(ctx, id, ShellsSnoozed); err != nil {
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
	if !wasInterrupted {
		putAwayStatus(&rec.s, ReasonSnoozed, m.opts.Now()) // the close cut off a turn: not a failure
	}
	set(&rec.s)
	rec.s.Pinned = false
	clearSnoozeEnded(&rec.s, m.opts.Now()) // a re-snooze: the last wake is old news
	m.unarchiveLocked(rec)
	m.commitLocked(rec, true)
	return rec.s, nil
}

// unsnoozeLocked clears rec's SnoozedUntil and SavedAt and reports whether either was
// set, so the caller commits. Pin(true), Send and Archive(true) unsnooze
// implicitly, at the same spots that unarchive. Callers hold m.mu.
func (m *Manager) unsnoozeLocked(rec *record) bool {
	if !rec.s.Snoozed() {
		return false
	}
	rec.s.SnoozedUntil, rec.s.SavedAt = time.Time{}, time.Time{}
	return true
}

// clearSnoozeEnded turns a woken thread's "snooze ended" attention into idle at its
// prompt, and reports whether it did. Snooze and Archive call it (the user put the
// thread away again, so the wake no longer needs them), and New for rows archived or
// snoozed before they did.
func clearSnoozeEnded(s *Thread, now time.Time) bool {
	if s.Status != StatusNeedsAttention || s.StatusReason != ReasonSnoozeEnded {
		return false
	}
	return s.setStatus(StatusIdle, "at prompt", now)
}

// wakeSnoozed wakes every thread whose SnoozedUntil is not after Options.Now: it
// clears SnoozedUntil and, for a disconnected thread (every snoozed thread is one;
// a start unsnoozes), sets StatusNeedsAttention ReasonSnoozeEnded stamped with the
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
