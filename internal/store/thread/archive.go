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
// ArchivedAt unless it already has one (a second archive keeps the first time). A Reconnect that
// wins the race between the close and that last step makes Archive fail rather than
// archive a live thread. Unarchiving only clears ArchivedAt: the thread stays
// disconnected until the user reconnects it.
func (m *Manager) Archive(ctx context.Context, id string, archived bool) (Session, error) {
	if !archived {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Session{}, err
		}
		if m.unarchiveLocked(rec) {
			m.commitLocked(rec, true)
		}
		return rec.s, nil
	}
	if err := m.Close(ctx, id); err != nil {
		return Session{}, err
	}
	if err := m.removeShells(ctx, id); err != nil {
		return Session{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Session{}, err
	}
	if rec.run != nil || rec.s.State != StateDisconnected {
		return Session{}, fmt.Errorf("%w: session %s was started while being archived", ErrFailedPrecondition, id)
	}
	unsnoozed := m.unsnoozeLocked(rec) // archive and snooze are exclusive
	if !rec.s.ArchivedAt.IsZero() && !rec.s.Pinned && !unsnoozed {
		return rec.s, nil
	}
	if rec.s.ArchivedAt.IsZero() {
		rec.s.ArchivedAt = m.opts.Now()
	}
	rec.s.Pinned = false
	m.commitLocked(rec, true)
	m.log.Info("archived thread", "session", id)
	return rec.s, nil
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
