package thread

import (
	"context"
	"fmt"
	"time"
)

// Archive archives or unarchives a thread (docs/notes/archive-threads-1-daemon.md).
//
// Archiving closes the thread like Close (a no-op when it is disconnected), kills and
// removes its shells like Remove, then, under m.mu, unpins and unsnoozes it and stamps
// ArchivedAt unless it already has one (a second archive keeps the first time). A turn
// the close cut off leaves the thread idle ReasonArchived instead of error
// ReasonInterrupted. A Reconnect that
// wins the race between the close and that last step makes Archive fail rather than
// archive a live thread. Unarchiving only clears ArchivedAt: the thread stays
// disconnected until the user reconnects it.
func (m *Manager) Archive(ctx context.Context, id string, archived bool) (Thread, error) {
	if !archived {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Thread{}, err
		}
		if m.unarchiveLocked(rec) {
			m.commitLocked(rec, true)
		}
		return rec.s, nil
	}
	wasInterrupted, err := m.interrupted(id)
	if err != nil {
		return Thread{}, err
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
		return Thread{}, fmt.Errorf("%w: thread %s was started while being archived", ErrFailedPrecondition, id)
	}
	// The close cut off a turn (or a pending request): the archive stopped it, not a
	// failure, so it reads idle "archived" rather than error "interrupted".
	stopped := !wasInterrupted && rec.s.Status == StatusError && rec.s.StatusReason == ReasonInterrupted
	if stopped {
		rec.s.setStatus(StatusIdle, ReasonArchived, m.opts.Now())
	}
	unsnoozed := m.unsnoozeLocked(rec) // archive and snooze are exclusive
	if !rec.s.ArchivedAt.IsZero() && !rec.s.Pinned && !unsnoozed && !stopped {
		return rec.s, nil
	}
	if rec.s.ArchivedAt.IsZero() {
		rec.s.ArchivedAt = m.opts.Now()
	}
	rec.s.Pinned = false
	// The user is done with it: plugins' flags go too (flags.go).
	if _, err := m.dropFlagsLocked(ctx, rec, func(Flag) bool { return true }); err != nil {
		m.log.Warn("clear the flags of an archived thread", "thread", id, "err", err)
	}
	m.commitLocked(rec, true)
	m.log.Info("archived thread", "thread", id)
	return rec.s, nil
}

// interrupted reports whether thread id's status is already error "interrupted" (a
// process that ended mid-turn before the archive).
func (m *Manager) interrupted(id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return false, err
	}
	return rec.s.Status == StatusError && rec.s.StatusReason == ReasonInterrupted, nil
}

// unarchiveLocked clears rec's ArchivedAt and reports whether it was set, so the
// caller commits. Reconnect, Pin(true) and Send unarchive implicitly: a thread the user
// works with again belongs in the main list. Callers hold m.mu.
func (m *Manager) unarchiveLocked(rec *record) bool {
	if rec.s.ArchivedAt.IsZero() {
		return false
	}
	rec.s.ArchivedAt = time.Time{}
	return true
}

// backToList unarchives and unsnoozes (unarchiveLocked, unsnoozeLocked) for a caller
// without m.mu (Send), committing and publishing when the thread was either.
func (m *Manager) backToList(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	unarchived := m.unarchiveLocked(rec)
	if m.unsnoozeLocked(rec) || unarchived {
		m.commitLocked(rec, true)
	}
}
