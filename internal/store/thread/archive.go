package thread

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Archive archives or unarchives a thread (docs/notes/archive-threads-1-daemon.md).
//
// Archiving first archives the threads below it (ArchiveCascade: every live thread its
// creator chain leads to; docs/notes/no-sidebar-override-2-daemon.md): their
// closes begin together, then each is archived in tree order, past one that fails
// (logged, and named in the *CascadeError returned with the thread); then the thread
// itself, then any hidden thread created below it meanwhile (its creator was still
// running). Unarchiving only
// clears ArchivedAt, of this thread alone: the thread stays disconnected until the
// user reconnects it.
func (m *Manager) Archive(ctx context.Context, id string, archived bool) (Thread, error) {
	return m.archive(ctx, id, archived, nil)
}

// archive is Archive. closing, set by a turn's end (finishPutAway), is the process that
// end began closing: the thread's own close then only waits for it, and comes before the
// cascade, so a message that started the thread again (closeAway) finds the threads below
// it untouched.
func (m *Manager) archive(ctx context.Context, id string, archived bool, closing *runner) (Thread, error) {
	if !archived {
		m.mu.Lock()
		defer m.mu.Unlock()
		rec, err := m.record(id)
		if err != nil {
			return Thread{}, err
		}
		m.dropPutAwayLocked(rec, "the thread was unarchived")
		if m.unarchiveLocked(rec) {
			m.commitLocked(rec, true)
		}
		return rec.s, nil
	}
	if _, err := m.Get(ctx, id); err != nil {
		return Thread{}, err
	}
	if err := m.refuseResident(id, "archived"); err != nil {
		return Thread{}, err
	}
	if closing != nil {
		if err := m.closeAway(ctx, id, closing); err != nil {
			return Thread{}, err
		}
	}
	by := archivedBy(ctx)
	tried := map[string]bool{}
	var failed []CascadeFailure
	cascaded := 0
	cascade := func() {
		targets := m.cascadeTargets(id, tried)
		// Their closes begin together (each may wait CloseTimeout for its process),
		// after what each was before any of them closed is read; the archives then
		// commit in tree order.
		was := make([]bool, len(targets))
		for i, t := range targets {
			tried[t.ID] = true
			was[i], _ = m.interrupted(t.ID) // gone meanwhile: archiveFrom says so
			m.unwatchForArchive(t.ID, by)   // before its close: its settle must wake no one
			m.markPuttingAway(t.ID, was[i], ReasonArchived)
		}
		for _, t := range targets {
			m.requestClose(t.ID)
		}
		for i, t := range targets {
			_, changed, err := m.archiveFrom(ctx, t.ID, was[i], nil)
			if err != nil {
				m.log.Warn("archive a hidden thread with the thread above it", "thread", t.ID, "root", id, "err", err)
				failed = append(failed, CascadeFailure{ID: t.ID, Err: err})
				continue
			}
			if changed {
				cascaded++
				m.log.Info("archived thread with the thread above it", "thread", t.ID, "root", id, "depth", t.Depth)
			}
		}
	}
	cascade()
	s, changed, err := m.archiveOne(ctx, id, by, closing)
	if err != nil {
		return Thread{}, err
	}
	if s.ID == "" {
		return Thread{}, m.notFound(id) // its create failed: there never was such a thread
	}
	cascade() // created below it while the others were archived
	if changed || cascaded > 0 {
		m.log.Info("archived thread", "thread", id, "cascaded", cascaded, "cascade_failed", len(failed))
	}
	if cur, err := m.Get(ctx, id); err == nil {
		s = cur // the cascade may have moved its waiting overlay
	}
	if len(failed) > 0 {
		return s, &CascadeError{ID: id, Failed: failed}
	}
	return s, nil
}

// cascadeTargets are the threads archiving id takes with it now (ArchiveCascade): not
// archived, not being removed, not in skip.
func (m *Manager) cascadeTargets(id string, skip map[string]bool) []Thread {
	var out []Thread
	for _, t := range ArchiveCascade(m.Snapshot().Threads, id) {
		if t.ArchivedAt.IsZero() && !t.Removing && !skip[t.ID] {
			out = append(out, t)
		}
	}
	return out
}

// CascadeFailure is one hidden thread an archive could not take with it.
type CascadeFailure struct {
	ID  string
	Err error
}

// CascadeError is Archive's (or Remove's) error when the thread was archived (removed)
// but some of the hidden threads below it were not. It is an ErrFailedPrecondition.
type CascadeError struct {
	ID     string // the thread archived or removed
	Failed []CascadeFailure
	Verb   string // "archived" (the default for "") or "removed"
}

func (e *CascadeError) Error() string {
	parts := make([]string, len(e.Failed))
	for i, f := range e.Failed {
		parts[i] = f.ID + ": " + f.Err.Error()
	}
	what := "1 hidden thread below it was"
	if len(e.Failed) != 1 {
		what = fmt.Sprintf("%d hidden threads below it were", len(e.Failed))
	}
	verb := e.Verb
	if verb == "" {
		verb = "archived"
	}
	return fmt.Sprintf("%s thread %s, but %s not %s: %s", verb, e.ID, what, verb, strings.Join(parts, "; "))
}

// Unwrap makes a CascadeError an ErrFailedPrecondition.
func (e *CascadeError) Unwrap() error { return ErrFailedPrecondition }

// archiveOne archives one thread, and reports whether anything changed.
//
// It forgets the thread's wake subscriptions and the wakes about it first
// (unwatchForArchive), closes the thread like Close (a no-op when it is disconnected),
// kills and removes its shells and stops what it left running in its worktree like
// Remove, then, under m.mu, unpins and unsnoozes it, clears a "snooze ended" status
// (clearSnoozeEnded), and stamps
// ArchivedAt unless it already has one (a second archive keeps the first time). A turn
// the close cut off leaves the thread idle ReasonArchived instead of error
// ReasonInterrupted. A start that wins the race between the close and that last
// step makes it fail rather than archive a live thread.
func (m *Manager) archiveOne(ctx context.Context, id, by string, closing *runner) (Thread, bool, error) {
	wasInterrupted, err := m.interrupted(id)
	if err != nil {
		return Thread{}, false, err
	}
	m.unwatchForArchive(id, by) // before the close: its settle must wake no one
	m.markPuttingAway(id, wasInterrupted, ReasonArchived)
	return m.archiveFrom(ctx, id, wasInterrupted, closing)
}

// archiveFrom is archiveOne with whether the thread was interrupted before its close
// began (interrupted) read already, and its wakes forgotten (unwatchForArchive).
func (m *Manager) archiveFrom(ctx context.Context, id string, wasInterrupted bool, closing *runner) (_ Thread, _ bool, err error) {
	defer func() { m.endPuttingAway(id, err != nil); m.endArchiving(id, err != nil) }() // after m.mu's unlock below
	// A setup under way ends first, either way: then there is a process to close, or none.
	if err := m.endSetupToArchive(ctx, id); err != nil {
		return Thread{}, false, err
	}
	if _, ok := m.Snapshot().Thread(id); !ok && m.createFailed(id) {
		return Thread{}, false, nil // nothing to archive, and no failure of the archive's
	}
	if err := m.closeAway(ctx, id, closing); err != nil {
		return Thread{}, false, err
	}
	if err := m.removeShells(ctx, id, ShellsArchived); err != nil {
		return Thread{}, false, err
	}
	m.stopStrays(ctx, id) // what its Bash calls left running in its worktree (strays.go)
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, false, err
	}
	if rec.run != nil || rec.s.State != StateDisconnected {
		return Thread{}, false, fmt.Errorf("%w: thread %s was started while being archived", ErrFailedPrecondition, id)
	}
	// The close cut off a turn (or a pending request): the archive stopped it, not a
	// failure, so it reads idle "archived" rather than error "interrupted".
	stopped := !wasInterrupted && putAwayStatus(&rec.s, ReasonArchived, m.opts.Now())
	unsnoozed := m.unsnoozeLocked(rec) // archive and snooze are exclusive
	woke := clearSnoozeEnded(&rec.s, m.opts.Now())
	if !rec.s.ArchivedAt.IsZero() && !rec.s.Pinned && !unsnoozed && !stopped && !woke {
		return rec.s, false, nil
	}
	newly := rec.s.ArchivedAt.IsZero()
	if newly {
		rec.s.ArchivedAt = m.opts.Now()
	}
	rec.s.Pinned = false
	// The user is done with it: plugins' flags go too (flags.go).
	if _, err := m.dropFlagsLocked(ctx, rec, func(Flag) bool { return true }); err != nil {
		m.log.Warn("clear the flags of an archived thread", "thread", id, "err", err)
	}
	m.commitLocked(rec, true)
	if newly && m.opts.Archived != nil {
		m.opts.Archived(rec.s) // its worktrees nobody else has go (the daemon's cleanupArchived)
	}
	return rec.s, true, nil
}

// requestClose begins closing thread id's process, if it runs, without waiting
// (Close waits).
func (m *Manager) requestClose(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok && rec.run != nil {
		rec.run.requestClose()
	}
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
// caller commits. Pin(true) and Send unarchive implicitly: a thread the user
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
