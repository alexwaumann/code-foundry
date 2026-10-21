package thread

import (
	"slices"
	"time"
)

// Wakes about a thread being archived (docs/notes/ember-fixes-2-wakes.md, e12-2 of the
// 2026-10-21 battle test). An archive closes the thread, and a busy thread's close is a
// settle: its subscriber's settled subscription used to fire on it, so an orchestrator
// that cancelled a worker (interrupt, archive) got a second turn about the worker it had
// just archived ("is idle: at prompt (no report)"). So, before the close, the archive
// deletes the thread's subscriptions and those to it (forgetLocked, which also drops the
// held wakes about it and the wakes queued to it), and drops the thread wakes about it
// still queued for other subscribers; a thread wake whose target was archived by the
// time it is sent is dropped too (archivedTargets: one a batch window held already).

// unwatchForArchive is unwatchForArchiveLocked, taking m.mu.
func (m *Manager) unwatchForArchive(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unwatchForArchiveLocked(id)
}

// unwatchForArchiveLocked forgets thread id's wakes before an archive closes it; the
// subscribers that waited on it are re-evaluated (waiting.go). Callers hold m.mu, and
// not m.subs.mu.
func (m *Manager) unwatchForArchiveLocked(id string) {
	s := m.subs
	if s == nil {
		return
	}
	subscribers := s.subscribersOf(id)
	s.mu.Lock()
	var about []string
	for sid, r := range s.byID {
		if r.s.TargetKind == TargetThread && r.s.TargetID == id {
			about = append(about, sid)
		}
	}
	for subscriber, q := range s.queues {
		var refund []string
		q.items = slices.DeleteFunc(q.items, func(d delivery) bool {
			drop := d.thread != nil && slices.Contains(about, d.sub)
			if drop {
				refund = append(refund, d.sub)
				if !d.slot.IsZero() {
					s.refundLocked(subscriber, []time.Time{d.slot})
				}
			}
			return drop
		})
		if len(refund) > 0 {
			m.log.Info("wake dropped: its target is being archived", "thread", subscriber, "target", id, "subscriptions", refund)
			if !slices.Contains(subscribers, subscriber) {
				subscribers = append(subscribers, subscriber)
			}
		}
	}
	s.mu.Unlock()
	m.forgetLocked(id, "archived")
	m.rewaitLocked(subscribers)
}

// archivedTargets drops the parts about threads archived since they fired (snap has
// them archived): a wake must not tell a subscriber about a thread the archive put away.
func archivedTargets(snap *Snapshot, parts []threadWakePart) []threadWakePart {
	return slices.DeleteFunc(parts, func(p threadWakePart) bool {
		t, ok := snap.Thread(p.t.ID)
		return ok && !t.ArchivedAt.IsZero()
	})
}
