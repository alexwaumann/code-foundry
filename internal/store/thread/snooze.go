package thread

import (
	"context"
	"errors"
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
// (docs/notes/snooze-threads-1-daemon.md, docs/notes/snooze-without-teardown.md).
//
// A snooze only hides the thread until later: its process, a turn it is in, its shells
// and background shells, its pin and its subscriptions are left as they are. Under m.mu it
// unarchives the thread, clears a "snooze ended" left by an earlier wake and sets
// SnoozedUntil (replacing an earlier snooze, or a save for later). until must be after
// Options.Now. The idle stop stops a snoozed thread's process as any other's. Unsnoozing
// only clears SnoozedUntil and SavedAt: the thread is left as it is and gets no
// attention.
func (m *Manager) Snooze(ctx context.Context, id string, until time.Time) (Thread, error) {
	if until.IsZero() {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Thread{}, err
		}
		if err := m.refuseHeldLocked(rec, askedBy(ctx), false, true, "dismiss the snooze of"); err != nil {
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
	s, err := m.putAway(ctx, id, func(rec *record) {
		rec.s.SnoozedUntil, rec.s.SavedAt = until, time.Time{}
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
	s, err := m.putAway(ctx, id, func(rec *record) {
		rec.s.SnoozedUntil = time.Time{}
		if rec.s.SavedAt.IsZero() {
			rec.s.SavedAt = m.opts.Now().Round(0).Truncate(time.Millisecond)
		}
	})
	if err != nil {
		return Thread{}, err
	}
	m.log.Info("saved thread for later", "thread", id)
	return s, nil
}

// putAway is the part of a snooze both forms share: under m.mu it drops an archive the
// thread asked of itself for its turn's end (the later put-away wins), applies set,
// unarchives the thread, clears a "snooze ended" left by an earlier wake and commits; on a
// running thread that attention is its process's, cleared there after the commit. Nothing is closed, removed or unpinned
// (docs/notes/snooze-without-teardown.md). An event an earlier snooze waited on is dropped
// before set runs (snooze_event.go): set may make the thread wait on a new one.
func (m *Manager) putAway(ctx context.Context, id string, set func(*record)) (Thread, error) {
	if err := m.refuseResident(id, "snoozed"); err != nil {
		return Thread{}, err
	}
	// It unarchives: a thread may do that only to a thread it created (holds.go).
	if err := m.refuseHeld(ctx, id, true, false, "snooze"); err != nil {
		return Thread{}, err
	}
	if err := m.refuseSettingUp(id, "snoozed"); err != nil {
		return Thread{}, err
	}
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return Thread{}, err
	}
	m.dropPutAwayLocked(rec, "the thread was snoozed") // an archive of itself it asked for
	m.dropSnoozeEventLocked(rec)
	set(rec)
	live := rec.run != nil
	if !live {
		clearSnoozeEnded(&rec.s, m.opts.Now()) // a re-snooze: the last wake is old news
	}
	m.unarchiveLocked(rec)
	m.commitLocked(rec, true)
	s := rec.s
	m.mu.Unlock()
	if !live {
		return s, nil
	}
	// The running process holds a wake's attention (streamStatus.snoozeEnded): it goes there.
	if err := m.setSnoozeEnded(ctx, id, false); err != nil {
		return Thread{}, err
	}
	return m.Get(ctx, id)
}

// unsnoozeLocked clears rec's SnoozedUntil and SavedAt (and an event it waited on) and reports whether either was
// set, so the caller commits. Pin(true), the user's Send and Archive(true) unsnooze
// implicitly; another thread's Send or a wake does not (holds.go). Callers hold m.mu.
func (m *Manager) unsnoozeLocked(rec *record) bool {
	if !rec.s.Snoozed() {
		return false
	}
	m.dropSnoozeEventLocked(rec) // what an event snooze waited on (snooze_event.go)
	rec.s.SnoozedUntil, rec.s.SavedAt = time.Time{}, time.Time{}
	return true
}

// clearSnoozeEnded turns a woken thread's "snooze ended" attention into idle at its
// prompt, and reports whether it did. Snooze and Archive call it (the user put the
// thread away again, so the wake no longer needs them), ClearSnoozeEnded (the user
// cleared it), and New for rows archived or snoozed before they did.
func clearSnoozeEnded(s *Thread, now time.Time) bool {
	if s.Status != StatusNeedsAttention || s.StatusReason != ReasonSnoozeEnded {
		return false
	}
	return s.setStatus(StatusIdle, "at prompt", now)
}

// ClearSnoozeEnded turns a woken thread's "snooze ended" attention into idle at its
// prompt, persisted and published, as a re-snooze or an archive does: the user saw the
// wake and wants nothing more from it (thread.snooze.clear). cleared is false, and
// nothing changes, when the thread is not woken.
func (m *Manager) ClearSnoozeEnded(ctx context.Context, id string) (_ Thread, cleared bool, _ error) {
	before, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, false, err
	}
	if before.Status != StatusNeedsAttention || before.StatusReason != ReasonSnoozeEnded {
		return before, false, nil
	}
	if err := m.setSnoozeEnded(ctx, id, false); err != nil {
		return Thread{}, false, err
	}
	s, err := m.Get(ctx, id)
	if err != nil {
		return Thread{}, false, err
	}
	m.log.Info("cleared snooze ended", "thread", id)
	return s, true, nil
}

// setSnoozeEnded sets (mark) or clears thread id's "snooze ended" attention: on its runner
// while it runs (streamStatus.snoozeEnded, so the status the runner publishes keeps it),
// else on its row. A runner marks it only at its prompt: a thread that works when its
// snooze ends keeps its own status. A stopped thread is marked only while disconnected.
func (m *Manager) setSnoozeEnded(ctx context.Context, id string, mark bool) error {
	for {
		live, closing, reserved, _, err := m.lifecycle(id)
		switch {
		case err != nil:
			return err
		case live != nil:
			_, err := live.exchange(ctx, threadCmd{snoozeEnded: &mark})
			if errors.Is(err, errProcessGone) {
				continue
			}
			return err
		case closing != nil:
			if err := waitDone(ctx, closing); err != nil {
				return err
			}
			continue
		case reserved != nil:
			select {
			case <-reserved:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		now := m.opts.Now()
		_, ok, err := m.updateStopped(id, func(s *Thread) {
			if !mark {
				clearSnoozeEnded(s, now)
			} else if s.State == StateDisconnected {
				s.Status, s.StatusReason, s.StatusChangedAt = StatusNeedsAttention, ReasonSnoozeEnded, now
			}
		})
		if err != nil || ok {
			return err
		}
		// started meanwhile
	}
}

// onSnoozeEnded is setSnoozeEnded on the runner's goroutine: published at once, as a
// wake's status should not wait for the debounce.
func (r *runner) onSnoozeEnded(mark bool) {
	d := r.st.sd
	switch {
	case !mark && !d.snoozeEnded:
		return
	case mark && (r.closing || r.puttingAway || !d.AtPrompt()):
		return // it works, or is on its way out: its own status says so
	}
	d.snoozeEnded = mark
	if r.debounce != nil {
		r.debounce.Stop()
		r.debounce = nil
	}
	r.publishStatus()
}

// wakeSnoozed wakes every thread whose SnoozedUntil is not after Options.Now: it
// clears SnoozedUntil, persisted and published, and then marks it NeedsAttention
// ReasonSnoozeEnded stamped with the wake time (setSnoozeEnded): on its row when it is
// stopped, on its runner when its process runs and Claude is at its prompt. A thread that
// works when its snooze ends (a snooze no longer stops anything) keeps its own status. The
// status is stamped even when it already reads "snooze ended" (a re-snoozed thread that
// was never reconnected), so the GUI's "ended … ago" counts from this wake.
//
// It compares wall-clock times on purpose: SnoozedUntil carries no monotonic reading
// (Snooze strips it, the database and the API have none), and Go's monotonic clock
// stops while the Mac sleeps, so a single timer set for the snooze would fire late by
// the time slept. New calls it once (snoozes that ended while the daemon was stopped),
// then wakeSnoozedLoop every Options.SnoozeCheckInterval.
func (m *Manager) wakeSnoozed() {
	now := m.opts.Now().Round(0)
	var woke []string
	m.mu.Lock()
	for id, rec := range m.recs {
		if rec.s.SnoozedUntil.IsZero() || rec.s.SnoozedUntil.After(now) {
			continue
		}
		until := rec.s.SnoozedUntil
		rec.s.SnoozedUntil = time.Time{}
		if rec.run == nil && rec.s.State == StateDisconnected {
			rec.s.Status, rec.s.StatusReason, rec.s.StatusChangedAt = StatusNeedsAttention, ReasonSnoozeEnded, now
		} else {
			woke = append(woke, id)
		}
		m.commitLocked(rec, true)
		m.log.Info("snooze ended", "thread", id, "until", until, "late", now.Sub(until).Round(time.Second))
	}
	m.mu.Unlock()
	for _, id := range woke {
		if err := m.setSnoozeEnded(m.ctx, id, true); err != nil && m.ctx.Err() == nil {
			m.log.Warn("mark snooze ended", "thread", id, "err", err)
		}
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
