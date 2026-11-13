package thread

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Group wakes (docs/notes/wake-groups.md). A parent that fans out independent pieces gains
// nothing from a wake per child: of 70 wakes that came while siblings worked, 40 turns ran no
// tool and 3 acted. `thread new --notify-group <name>` puts the subscription in a group, and
// a plain settle of a member is held until none of the group works, then all of them go
// together: the batch window makes them one message.
//
// Nothing that needs the parent waits: a prompt, a question, an error, or a current blocked or
// failed report goes at once, and a thread ask is no settle at all. Work that feeds other
// work wants plain --notify. Held wakes are in memory, like a lead's: the stop records them
// (suppressHeldLocked) and the next start sends them with its notice.

// groupArg holds a subscription's group in its args: no column, and the args persist.
const groupArg = "group"

// Group is the subscription's wake group, "" for none.
func (s Subscription) Group() string { return s.Args[groupArg] }

// checkGroup validates a group name: a label's rules, for the same reasons.
func checkGroup(g string) (string, error) {
	if g == "" {
		return "", nil
	}
	c, err := CleanLabel(g)
	if err != nil {
		return "", fmt.Errorf("%w: group %q: letters, digits, -, _, . and / only", ErrInvalidArgument, strings.TrimSpace(g))
	}
	return c, nil
}

// groupWake is a held wake: the subscription as it fired and its target.
type groupWake struct {
	sub    Subscription
	target string
}

// groupHolds reports whether p waits for its group: a member's plain settle.
func groupHolds(p threadWakePart) bool {
	if p.released || p.sub.Group() == "" || p.sub.Condition != CondSettled || p.d.pending != nil {
		return false
	}
	t := p.t
	if !(t.Status == StatusIdle || (t.Status == StatusNeedsAttention && t.StatusReason == "finished")) {
		return false
	}
	return p.d.staleReport || (t.Report.Status != ReportBlocked && t.Report.Status != ReportFailed)
}

// holdGroupLocked keeps p for its group and reports true while a thread of the group works.
// The last one's wake is not held: the commit that settled it already let the others go
// (releaseHeldLocked), so it goes on, and the batch window joins them. Callers hold m.mu,
// not m.subs.mu.
func (m *Manager) holdGroupLocked(p threadWakePart) bool {
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.queues[p.sub.SubscriberID].droppedLocked(p.sub.ID) {
		return false // taken back: deliverThreadWakes drops it
	}
	if !m.groupWorks(p.sub.SubscriberID, p.sub.Group(), m.kidsLocked()) {
		m.releaseGroupsLocked(p.sub.SubscriberID)
		return false
	}
	if s.groups == nil {
		s.groups = map[string]map[string]map[string]groupWake{}
	}
	who, group := p.sub.SubscriberID, p.sub.Group()
	if s.groups[who] == nil {
		s.groups[who] = map[string]map[string]groupWake{}
	}
	if s.groups[who][group] == nil {
		s.groups[who][group] = map[string]groupWake{}
	}
	s.groups[who][group][p.sub.ID] = groupWake{sub: p.sub, target: p.t.ID}
	s.changedLocked(who) // one that ended with the finish is listed again (heldOnlyLocked)
	m.log.Info("wake held for its group", "thread", who, "group", group, "subscription", p.sub.ID, "target", p.t.ID)
	return true
}

// groupWorks reports whether a thread of subscriber's group still works. Callers hold
// m.mu and m.subs.mu.
func (m *Manager) groupWorks(subscriber, group string, kids map[string][]Thread) bool {
	for _, r := range m.subs.byID {
		if r.s.SubscriberID != subscriber || r.s.TargetKind != TargetThread || r.s.Group() != group {
			continue
		}
		rec, ok := m.recs[r.s.TargetID]
		if ok && rec.s.ArchivedAt.IsZero() && !rec.s.Removing && threadWorking(rec.s, kids, map[string]bool{}) {
			return true
		}
	}
	return false
}

// releaseGroupsLocked sends subscriber's held groups none of whose threads work. Callers
// hold m.mu and m.subs.mu.
func (m *Manager) releaseGroupsLocked(subscriber string) {
	s := m.subs
	if len(s.groups[subscriber]) == 0 {
		return
	}
	kids := m.kidsLocked()
	for group, held := range s.groups[subscriber] {
		if m.groupWorks(subscriber, group, kids) {
			continue
		}
		delete(s.groups[subscriber], group)
		gone := s.groupArchived[subscriber][group]
		delete(s.groupArchived[subscriber], group)
		ids := make([]string, 0, len(held))
		for id := range held {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		for _, id := range ids {
			m.releaseGroupWakeLocked(held[id], group, gone)
		}
	}
	if len(s.groups[subscriber]) == 0 {
		delete(s.groups, subscriber)
	}
	if len(s.groupArchived[subscriber]) == 0 {
		delete(s.groupArchived, subscriber)
	}
}

// releaseGroupWakeLocked queues one held wake about its target as it is now, naming the
// members archived meanwhile (gone); the batch window joins it to the others. Callers
// hold m.mu and m.subs.mu.
func (m *Manager) releaseGroupWakeLocked(w groupWake, group string, gone []wakeSibling) {
	s, sub := m.subs, w.sub
	s.changedLocked(sub.SubscriberID) // no longer listed, if its subscription is gone
	rec, ok := m.recs[w.target]
	if !ok {
		return
	}
	t, now := rec.s, m.opts.Now().Round(0).Truncate(time.Millisecond)
	joins := m.joinsBatchLocked(sub.SubscriberID)
	if !joins && !s.allowLocked(sub.SubscriberID, now, m.opts.WakeLimit) {
		m.log.Warn("group wake dropped: the subscriber reached the wake limit", "thread", sub.SubscriberID, "subscription", sub.ID, "target", t.ID)
		return
	}
	kids := m.childrenLocked(t.ID)
	d := delivery{sub: sub.ID, of: sub, queued: m.opts.batchClock.Now(), thread: func(ctx context.Context) threadWakePart {
		p := m.threadPart(ctx, sub, t, now, kids)
		p.released, p.d.archived = true, gone
		return p
	}}
	if !joins {
		d.slot = now
	}
	m.enqueueLocked(sub.SubscriberID, d)
	m.log.Info("wake released: its group settled", "thread", sub.SubscriberID, "group", group, "subscription", sub.ID, "target", t.ID)
}

// ungroupLocked drops sub's held wake: it fired again, and that fire stands for it, or a
// thread that ran again would come twice in its group's wake. Callers hold m.subs.mu.
func (s *subscriptions) ungroupLocked(sub Subscription) {
	groups := s.groups[sub.SubscriberID]
	held := groups[sub.Group()]
	delete(held, sub.ID)
	if len(held) == 0 {
		delete(groups, sub.Group())
	}
	if len(groups) == 0 {
		delete(s.groups, sub.SubscriberID)
	}
}

// forgetGroupsLocked drops the wakes held for or about thread id, and those of subscriptions
// ids. Callers hold m.subs.mu.
func (s *subscriptions) forgetGroupsLocked(id string, ids []string) {
	delete(s.groups, id)
	delete(s.groupArchived, id)
	for who, groups := range s.groups {
		for group, held := range groups {
			for sid, w := range held {
				if w.target == id || slices.Contains(ids, sid) {
					delete(held, sid)
				}
			}
			if len(held) == 0 {
				delete(groups, group)
			}
		}
		if len(groups) == 0 {
			delete(s.groups, who)
		}
	}
}
