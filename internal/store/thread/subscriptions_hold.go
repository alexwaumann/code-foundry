package thread

import (
	"context"
	"slices"
	"time"
)

// Held lead wakes (docs/notes/ember-fixes-1-wakes.md).
//
// A lead (a thread with children of its own) ends turns while its team works: the first
// one after it started its workers, then one per worker wake it handles. Each settle
// fires its parent's settled subscription, and each wake starts a parent turn that can
// only say "still running". So a settled wake about a lead is held, not sent, while:
//
//   - the lead's turn ended plainly (idle, waiting, or needs attention "finished"),
//   - its report is not a current done, failed or blocked one (none, progress, or one
//     filed before its last message, whatever its status),
//   - it had working children when the wake fired (teamWorking), and
//   - when the wake is sent, its children still work, or the lead is not quiet: working
//     again, shown waiting (waiting.go), or with a wake on its way to it.
//
// A child works while it is not settled (busy, starting, being removed), is shown
// waiting on threads of its own, or has a working team of its own. A child's pending
// request counts through its wake to the lead: the lead is not quiet until it was told.
//
// A held wake is counted (FiredCount) and logged "wake held: lead still has N workers";
// it takes no wake limit slot. It is released, as one wake about the lead as it is then,
// once the lead is quiet with no working child (checked on every commit of the lead or
// one of its descendants, a removal, and when a wake queue empties). A new fire of the
// same subscription replaces it: a lead subscribed to its workers is woken by the last
// one and its next settle wakes the parent the ordinary way. A lead's own pending
// request, error, budget stop or current done/failed/blocked report is never held.
// Held wakes are in memory: the stop records them (suppressHeldLocked), and the next
// start sends them with its notice.

// teamWorking counts thread id's working children; kids lists a thread's children that
// are not archived.
func teamWorking(id string, kids map[string][]Thread) int {
	n := 0
	for _, k := range kids[id] {
		if threadWorking(k, kids, map[string]bool{id: true}) {
			n++
		}
	}
	return n
}

// threadWorking reports whether k works: not settled, shown waiting on threads of its
// own, or with a working child. seen are the threads on the walk.
func threadWorking(k Thread, kids map[string][]Thread, seen map[string]bool) bool {
	if !Meets(CondSettled, k) || shownWaiting(k.Status, k.StatusReason) {
		return true
	}
	if seen[k.ID] {
		return false
	}
	seen[k.ID] = true
	return slices.ContainsFunc(kids[k.ID], func(c Thread) bool { return threadWorking(c, kids, seen) })
}

// childIndex lists threads' children by creator, archived ones left out.
func childIndex(threads []Thread) map[string][]Thread {
	kids := map[string][]Thread{}
	for _, k := range threads {
		if k.CreatedBy != "" && k.ArchivedAt.IsZero() {
			kids[k.CreatedBy] = append(kids[k.CreatedBy], k)
		}
	}
	return kids
}

// kidsLocked is childIndex of the records, those being archived left out
// (archive_group.go). Callers hold m.mu.
func (m *Manager) kidsLocked() map[string][]Thread {
	threads := make([]Thread, 0, len(m.recs))
	for _, rec := range m.recs {
		if !rec.archiving {
			threads = append(threads, rec.s)
		}
	}
	return childIndex(threads)
}

// heldLeadWake reports whether p is a lead's wake that may be held: a settled
// subscription, a turn that ended plainly, no current done/failed/blocked report, and
// children working when it fired. holdLocked decides with the team as it is now.
func heldLeadWake(p threadWakePart) bool {
	t := p.t
	ended := t.Status == StatusIdle || (t.Status == StatusNeedsAttention && t.StatusReason == "finished")
	final := t.Report.Status.final() && !p.d.staleReport
	return p.sub.Condition == CondSettled && ended && !final && p.d.children.Working > 0
}

// quietLocked reports whether rec needs nothing more to settle for good: settled, not
// shown waiting, and no wake queued to it or being delivered. Callers hold m.mu and
// m.subs.mu.
func (m *Manager) quietLocked(rec *record) bool {
	_, queued := m.subs.queues[rec.s.ID]
	return Meets(CondSettled, rec.s) && !shownWaiting(rec.s.Status, rec.s.StatusReason) && !queued
}

// holdLocked holds p (heldLeadWake allows it) when the lead's children still work or
// the lead is not quiet: it keeps the wake for release and reports the working
// children. Callers hold m.mu, not m.subs.mu.
func (m *Manager) holdLocked(p threadWakePart) (int, bool) {
	rec, ok := m.recs[p.t.ID]
	if !ok || !rec.s.ArchivedAt.IsZero() || rec.s.Removing {
		return 0, false
	}
	n := teamWorking(p.t.ID, m.kidsLocked())
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	if n == 0 && m.quietLocked(rec) {
		return 0, false
	}
	if s.queues[p.sub.SubscriberID].droppedLocked(p.sub.ID) {
		return 0, false // taken back: not held, and deliverThreadWakes drops it
	}
	if s.held == nil {
		s.held = map[string]map[string]Subscription{}
	}
	if s.held[p.t.ID] == nil {
		s.held[p.t.ID] = map[string]Subscription{}
	}
	s.held[p.t.ID][p.sub.ID] = p.sub
	s.changedLocked(p.sub.SubscriberID) // a one-shot is listed again (heldOnlyLocked)
	return n, true
}

// heldOnlyLocked are the held wakes to subscriber ("": to every thread) whose
// subscription is gone, by id: a one-shot goes when it fires, and so does a --notify
// subscription with its thread's finish (subscriptions_until.go), so a held wake, for a
// lead or for a group, is all that is left of it, and it will wake the thread all the
// same. Subscriptions lists them and Unsubscribe by id drops them. Callers hold s.mu.
func (s *subscriptions) heldOnlyLocked(subscriber string) map[string]Subscription {
	out := map[string]Subscription{}
	add := func(id string, sub Subscription) {
		if _, kept := s.byID[id]; !kept && (subscriber == "" || sub.SubscriberID == subscriber) {
			out[id] = sub
		}
	}
	for _, h := range s.held {
		for id, sub := range h {
			add(id, sub)
		}
	}
	for _, groups := range s.groups {
		for _, g := range groups {
			for id, w := range g {
				add(id, w.sub)
			}
		}
	}
	return out
}

// unholdLocked drops subscription sub's held wake about target: it fired again.
// Callers hold m.subs.mu.
func (s *subscriptions) unholdLocked(target, sub string) {
	if h := s.held[target]; h != nil {
		delete(h, sub)
		if len(h) == 0 {
			delete(s.held, target)
		}
	}
}

// forgetHeldLocked drops the held wakes about thread id, those to it, and those of
// subscriptions ids. Callers hold m.subs.mu.
func (s *subscriptions) forgetHeldLocked(id string, ids []string) {
	s.forgetGroupsLocked(id, ids)
	delete(s.held, id)
	for target, h := range s.held {
		for sid, sub := range h {
			if sub.SubscriberID == id || slices.Contains(ids, sid) {
				delete(h, sid)
			}
		}
		if len(h) == 0 {
			delete(s.held, target)
		}
	}
}

// releaseHeldLocked releases the held wakes about thread id and its creators up the
// chain, each once that lead is quiet with no working child. Callers hold m.mu, not
// m.subs.mu.
func (m *Manager) releaseHeldLocked(id string) {
	s := m.subs
	if s == nil || id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if (len(s.held) == 0 && len(s.groups) == 0) || m.closed {
		return
	}
	var kids map[string][]Thread
	for seen := map[string]bool{}; id != "" && !seen[id]; {
		seen[id] = true
		rec, ok := m.recs[id]
		if !ok {
			return
		}
		m.releaseGroupsLocked(id)
		if h := s.held[id]; len(h) > 0 && m.quietLocked(rec) {
			if kids == nil {
				kids = m.kidsLocked()
			}
			if teamWorking(id, kids) == 0 {
				delete(s.held, id)
				m.releaseLocked(rec.s, h)
			}
		}
		id = rec.s.CreatedBy
	}
}

// releaseLocked queues the held wakes h about lead t, as it is now. Callers hold m.mu
// and m.subs.mu.
func (m *Manager) releaseLocked(t Thread, h map[string]Subscription) {
	ids := make([]string, 0, len(h))
	for id := range h {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	s := m.subs
	kids := m.childrenLocked(t.ID)
	for _, id := range ids {
		sub := h[id]
		s.changedLocked(sub.SubscriberID) // no longer listed, if it was a one-shot
		now := m.opts.Now().Round(0).Truncate(time.Millisecond)
		joins := m.joinsBatchLocked(sub.SubscriberID)
		if !joins && !s.allowLocked(sub.SubscriberID, now, m.opts.WakeLimit) {
			m.log.Warn("held wake dropped: the subscriber reached the wake limit", "thread", sub.SubscriberID, "subscription", id, "target", t.ID)
			continue
		}
		d := delivery{sub: id, of: sub, queued: m.opts.batchClock.Now(), thread: func(ctx context.Context) threadWakePart { return m.threadPart(ctx, sub, t, now, kids) }}
		if !joins {
			d.slot = now
		}
		m.enqueueLocked(sub.SubscriberID, d)
		m.log.Info("wake released: the lead's children settled", "thread", sub.SubscriberID, "subscription", id, "target", t.ID,
			"children", kids.Total)
	}
}
