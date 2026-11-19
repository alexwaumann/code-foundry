package thread

import (
	"context"
	"fmt"
	"strings"
)

// The user's put-aways hold (docs/notes/snooze-holds-archive-refuses.md). A snooze and an
// archive are the user's decisions, which another thread cannot undo:
//
//   - A message or a wake that is not the user's does not end a snooze: the thread starts
//     if it must, works and stays snoozed with its time unchanged. Only the user ends one
//     (a message of theirs, a dismiss, the time arriving). A thread cannot dismiss another
//     thread's snooze, or pin it (pinning ends it), unless it created that thread.
//   - A thread cannot message, unarchive, pin, snooze or retry the setup of an archived
//     thread it did not create (each of those unarchives); a wake to an archived thread is
//     refused too. Reading it stays allowed.
//
// "Created" is the creator chain (createdByLocked): the thread that created it, or the one
// that created that one, and so on. Archiving a thread takes every thread below it along
// (ArchiveCascade walks the same chain), so a lead that archived its worker also archived
// the worker's workers, and must be able to bring any of them back.

// askedByKey carries the thread that asks the store for something.
type askedByKey struct{}

// AskedBy returns ctx carrying the thread that asks (an API request's by_thread_id): the
// one an archive names to a group's wake (archive_group.go), and the one the holds above
// are checked against for Archive(false), Pin, Snooze, SaveForLater and RetrySetup. None
// is the user (or a plugin).
func AskedBy(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, askedByKey{}, id)
}

// askedBy is the thread AskedBy put in ctx, or "".
func askedBy(ctx context.Context) string {
	id, _ := ctx.Value(askedByKey{}).(string)
	return id
}

// revive says who a message (or a setup retry) comes from, for what it may bring back:
// the user's brings the thread back to the list (unarchives and unsnoozes it); a
// thread's unarchives it only when that thread created it (the send was refused
// otherwise) and never unsnoozes it; a wake's does neither.
type revive struct {
	user bool
	by   string // the sending thread; "" for the user or a wake
}

// sender is who sent msg, for the holds: the user (a compact is the user's: it names the
// thread itself as sender only to keep it out of the prompt history), a wake, or a thread.
func (msg Message) sender() revive {
	switch {
	case msg.compact:
		return revive{user: true}
	case msg.Origin == OriginWake:
		return revive{}
	}
	if by := strings.TrimSpace(msg.ByThreadID); by != "" {
		return revive{by: by}
	}
	return revive{user: true}
}

// createdByLocked reports whether thread by is above thread id in the creator chain: it
// created id, or created the thread that did, and so on, at most MaxLineageDepth+1
// levels up. A removed thread ends the chain (its threads are the user's once it is gone,
// as the sidebar has it). Never for "" or for id itself. Callers hold m.mu.
func (m *Manager) createdByLocked(id, by string) bool {
	if by == "" || by == id {
		return false
	}
	cur := id
	for range MaxLineageDepth + 1 {
		rec, ok := m.recs[cur]
		if !ok || rec.s.CreatedBy == "" {
			return false
		}
		if rec.s.CreatedBy == by {
			return true
		}
		cur = rec.s.CreatedBy
	}
	return false
}

// mayUnarchiveLocked reports whether rv may unarchive rec: the user, or a thread above it.
func (m *Manager) mayUnarchiveLocked(rec *record, rv revive) bool {
	return rv.user || m.createdByLocked(rec.s.ID, rv.by)
}

// backToListLocked unarchives rec when rv may, and unsnoozes it when rv is the user's,
// and reports whether either changed, so the caller commits. Callers hold m.mu.
func (m *Manager) backToListLocked(rec *record, rv revive) bool {
	unarchived := m.mayUnarchiveLocked(rec, rv) && m.unarchiveLocked(rec)
	unsnoozed := rv.user && m.unsnoozeLocked(rec)
	return unarchived || unsnoozed
}

// archivedRefusal is the error for a thread that asked to do something to archived thread
// id that would unarchive it, a thread it did not create; what is the thing ("message an
// archived thread it did not create").
func archivedRefusal(id, what string) error {
	return fmt.Errorf("%w: thread %s is archived, and a thread cannot %s: only the user can unarchive it. "+
		"Read it instead (code-foundry thread read %s), or, if it is needed, tell the user", ErrFailedPrecondition, id, what, id)
}

// snoozedRefusal is the error for a thread that asked to end the snooze of snoozed thread
// id, a thread it did not create.
func snoozedRefusal(id, what string) error {
	return fmt.Errorf("%w: thread %s is snoozed, and a thread cannot %s: only the user ends a snooze. "+
		"A message still reaches it, and it stays snoozed", ErrFailedPrecondition, id, what)
}

// refuseArchivedSend refuses a message to archived thread id from rv when rv may not
// unarchive it: a thread that did not create it, or a wake (whose subscriptions an archive
// drops, so only a race gets here).
func (m *Manager) refuseArchivedSend(id string, rv revive) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok || rec.s.ArchivedAt.IsZero() || m.mayUnarchiveLocked(rec, rv) {
		return nil
	}
	if rv.by == "" {
		return fmt.Errorf("%w: thread %s is archived; a wake does not unarchive it", ErrFailedPrecondition, id)
	}
	return archivedRefusal(id, "message an archived thread it did not create")
}

// refuseHeldLocked refuses thread by (from ctx, AskedBy) doing to rec what would unarchive
// it (unarchives) or end its snooze (unsnoozes) when by did not create it; what names the
// thing for the error. nil for the user. Callers hold m.mu.
func (m *Manager) refuseHeldLocked(rec *record, by string, unarchives, unsnoozes bool, what string) error {
	if by == "" || m.createdByLocked(rec.s.ID, by) {
		return nil
	}
	if unarchives && !rec.s.ArchivedAt.IsZero() {
		return archivedRefusal(rec.s.ID, what+" an archived thread it did not create")
	}
	if unsnoozes && rec.s.Snoozed() {
		return snoozedRefusal(rec.s.ID, what+" a snoozed thread it did not create")
	}
	return nil
}

// refuseHeld is refuseHeldLocked for a caller without m.mu; an unknown id is not refused
// here (the caller reports it).
func (m *Manager) refuseHeld(ctx context.Context, id string, unarchives, unsnoozes bool, what string) error {
	by := askedBy(ctx)
	if by == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.recs[id]
	if !ok {
		return nil
	}
	return m.refuseHeldLocked(rec, by, unarchives, unsnoozes, what)
}
