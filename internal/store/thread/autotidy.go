package thread

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Auto-tidy (docs/notes/auto-tidy.md): the daemon steps idle threads down the sidebar on its
// own, Active → Snoozed (saved for later, no alarm) → Archived, each after a time the user
// sets (threads.auto_save_after, threads.auto_archive_after; both off by default). The
// daemon's glue (internal/daemon/auto_tidy.go) decides on its tick which threads, adding the
// rules this store cannot see (a notification naming the thread), and posts the bell card;
// this file holds the thread rules and the two acts, each checking its rule again under m.mu
// so a thread that changed since the glue looked is left alone.
//
// The clock of the first step is LastActivityAt: the thread's creation, each start of its
// process, every message sent to Claude (the user's, another thread's, a wake), the user's
// answer to a prompt, and every line Claude's stream writes. Looking at a thread is not
// activity. Nor is that clock older than ReturnedAt, when the thread last came back from
// Snoozed or Archived, so a thread the user took back out is not put away again at once. The
// clock of the second is SavedAt.

// TidyRefusal says why auto-tidy leaves t where it is, whatever its clocks read, or "" when
// it is one auto-tidy may step down: the user's own thread (not a resident thread, not one a
// plugin owns, not one another thread created while that thread exists: InSidebar), not being
// removed, at rest (TidyAtRest). exists is InSidebar's.
func TidyRefusal(t Thread, exists func(id string) bool) string {
	switch {
	case t.Kind == KindResident:
		return "resident"
	case t.Owner != "":
		return "owned by " + t.Owner
	case !t.InSidebar(exists):
		return "created by a thread"
	case t.Removing:
		return "being removed"
	}
	return TidyAtRest(t)
}

// TidyAtRest says why t is not at rest, or "" when it is: idle at its prompt (running or
// stopped), with nothing under way that will bring it back by itself. Not working,
// starting, closing or setting up; not asking, finished unseen or marked unread, woken from a
// snooze or in error (each needs attention or is an error: Status); not waiting on child
// threads or its own background work, and no wake queued for it; no move or reseed pending.
// A status not known yet (a row from before statuses were kept) is not at rest either.
func TidyAtRest(t Thread) string {
	_, bgAgents := t.AgentsRunning()
	switch {
	case t.State != StateConnected && t.State != StateDisconnected:
		return t.State.String()
	case t.setupUnfinished():
		return "setting up"
	case t.Status != StatusIdle:
		if t.StatusReason != "" {
			return t.Status.String() + " (" + t.StatusReason + ")"
		}
		return t.Status.String()
	case strings.HasPrefix(t.StatusReason, ReasonWaiting):
		return t.StatusReason
	case t.PendingRequestID != "":
		return "asking"
	case t.WakePending || t.BackgroundShellsRunning > 0 || bgAgents > 0:
		return "background work"
	case t.PendingMove != nil || t.PendingWorktreePath != "" || t.ReseedPending:
		return "a move or reseed pending"
	}
	return ""
}

// AutoSaveDue reports whether auto-tidy's first step applies to t now: it may be stepped down
// (TidyRefusal), it is not archived, snoozed (until a time or an event), saved or pinned, and
// its last activity, and its last return from Snoozed or Archived (ReturnedAt), are before
// idleBefore (now minus threads.auto_save_after).
func AutoSaveDue(t Thread, exists func(id string) bool, idleBefore time.Time) bool {
	return t.ArchivedAt.IsZero() && !t.Snoozed() && t.SnoozeEvent == nil && !t.Pinned &&
		t.LastActivityAt.Before(idleBefore) && t.ReturnedAt.Before(idleBefore) && TidyRefusal(t, exists) == ""
}

// AutoArchiveDue reports whether auto-tidy's second step applies to t now: it is saved for
// later (no alarm: a timed snooze is never archived by it, nor a snooze until an event, which
// is a save for later waiting on something: docs/notes/snooze-until-event.md), by the user or
// by AutoSave, since before savedBefore (now minus threads.auto_archive_after), not archived,
// not pinned, and it may be stepped down (TidyRefusal: a saved thread that works because
// another thread wrote to it stays until it rests).
func AutoArchiveDue(t Thread, exists func(id string) bool, savedBefore time.Time) bool {
	return t.ArchivedAt.IsZero() && t.SnoozedUntil.IsZero() && t.SnoozeEvent == nil && !t.SavedAt.IsZero() && !t.Pinned &&
		t.SavedAt.Before(savedBefore) && TidyRefusal(t, exists) == ""
}

// existsLocked is InSidebar's exists over the records. Callers hold m.mu.
func (m *Manager) existsLocked(id string) bool {
	_, ok := m.recs[id]
	return ok
}

// AutoSave saves thread id for later as auto-tidy's first step, when AutoSaveDue still holds
// under m.mu (saved false and nothing changed otherwise): what SaveForLater does to a thread
// at rest (SavedAt now, nothing closed, removed or unpinned; the layout glue closes its tab
// on the Updated as for the user's save), plus AutoSavedAfter = after, the setting it was
// saved by.
func (m *Manager) AutoSave(_ context.Context, id string, after time.Duration, idleBefore time.Time) (_ Thread, saved bool, _ error) {
	if after <= 0 {
		return Thread{}, false, fmt.Errorf("%w: auto-save needs a positive time", ErrInvalidArgument)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, false, err
	}
	if rec.setup != nil || !AutoSaveDue(rec.s, m.existsLocked, idleBefore) {
		return rec.s, false, nil
	}
	m.dropPutAwayLocked(rec, "auto-tidy saved the thread for later")
	rec.s.SnoozedUntil = time.Time{}
	rec.s.SavedAt = m.opts.Now().Round(0).Truncate(time.Millisecond)
	rec.s.AutoSavedAfter = after
	m.commitLocked(rec, true)
	m.log.Info("auto-tidy saved thread for later", "thread", id, "idle_since", rec.s.LastActivityAt, "after", after)
	return rec.s, true, nil
}

// AutoArchive archives thread id as auto-tidy's second step, when AutoArchiveDue holds (the
// user's Archive otherwise: the process closed, its shells ended, the threads it created
// taken along). archived is false, and nothing changed, when it no longer applies. The check
// and the archive are not one step under m.mu (Archive closes processes outside it): a user
// who unsnoozes the thread in that moment finds it archived, and unarchives it.
func (m *Manager) AutoArchive(ctx context.Context, id string, savedBefore time.Time) (_ Thread, archived bool, _ error) {
	m.mu.Lock()
	rec, err := m.record(id)
	if err != nil {
		m.mu.Unlock()
		return Thread{}, false, err
	}
	due := rec.setup == nil && rec.putAway == nil && AutoArchiveDue(rec.s, m.existsLocked, savedBefore)
	s := rec.s
	m.mu.Unlock()
	if !due {
		return s, false, nil
	}
	savedAt := s.SavedAt
	s, err = m.Archive(ctx, id, true)
	if err != nil {
		return s, false, err
	}
	m.log.Info("auto-tidy archived thread", "thread", id, "saved_at", savedAt)
	return s, true, nil
}
