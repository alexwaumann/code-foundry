package thread

import (
	"context"
	"slices"
)

// A group member archived (docs/notes/wakes-fuzz-fixes.md). An archive drops the
// member's subscription before its close (archive_wakes.go), which lets its group's held
// wakes go, but ArchivedAt is stamped only once the close is over, seconds later at
// times: until then the member counted as a settled child, and the wake read "All 3 of
// your child threads settled" with nothing about the one archived. So the record is
// marked archiving from before the unwatch to the archive's end, and the counts
// (kidsLocked, siblingsOf) leave it out; and when someone other than the subscriber
// archived it (the user, a plugin, another thread), the group's next released wake
// names it.

// archivedByKey carries the thread that asks for an archive.
type archivedByKey struct{}

// ArchivedBy returns ctx carrying the thread that asks Archive for it (an API request's
// by_thread_id); none is the user or a plugin.
func ArchivedBy(ctx context.Context, id string) context.Context {
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, archivedByKey{}, id)
}

// archivedBy is the thread ArchivedBy put in ctx, or "".
func archivedBy(ctx context.Context) string {
	id, _ := ctx.Value(archivedByKey{}).(string)
	return id
}

// markArchivingLocked marks thread id archiving and notes it for the groups its
// subscribers other than by hold it in: those holding wakes, or with a member still
// working (their wakes will be held). Before the unwatch, which drops the
// subscriptions. Callers hold m.mu, not m.subs.mu.
func (m *Manager) markArchivingLocked(id, by string) {
	rec, ok := m.recs[id]
	if !ok {
		return
	}
	rec.archiving = true
	s := m.subs
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	member := wakeSibling{ID: id, Name: rec.s.Name}
	kids := m.kidsLocked()
	for _, r := range s.byID {
		who, group := r.s.SubscriberID, r.s.Group()
		if r.s.TargetKind != TargetThread || r.s.TargetID != id || group == "" || who == by {
			continue
		}
		if len(s.groups[who][group]) == 0 && !m.groupWorks(who, group, kids) {
			continue // nothing held, nothing to come: no wake to say it in
		}
		if s.groupArchived == nil {
			s.groupArchived = map[string]map[string][]wakeSibling{}
		}
		if s.groupArchived[who] == nil {
			s.groupArchived[who] = map[string][]wakeSibling{}
		}
		if !slices.Contains(s.groupArchived[who][group], member) {
			s.groupArchived[who][group] = append(s.groupArchived[who][group], member)
		}
		m.log.Info("group member archived", "thread", who, "group", group, "member", id, "by", by)
	}
}

// endArchiving clears thread id's archiving mark: its archive is over, stamped or failed.
func (m *Manager) endArchiving(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if rec, ok := m.recs[id]; ok {
		rec.archiving = false
	}
}

// archivingLocked are the threads being archived. Callers hold m.mu.
func (m *Manager) archivingLocked() map[string]bool {
	out := map[string]bool{}
	for id, rec := range m.recs {
		if rec.archiving {
			out[id] = true
		}
	}
	return out
}

// archivedSentence names the subscriber's children archived while their group waited:
// ""A" (s-1) was archived." or ""A" (s-1), "B" (s-2) were archived."; "" for none.
func archivedSentence(gone []wakeSibling) string {
	if len(gone) == 0 {
		return ""
	}
	names := make([]string, 0, len(gone))
	for _, g := range gone {
		names = append(names, siblingLabel(g.ID, g.Name))
	}
	if len(names) == 1 {
		return names[0] + " was archived."
	}
	return listNames(names) + " were archived."
}
