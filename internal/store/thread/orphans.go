package thread

import "context"

// Children of a removed thread (docs/notes/thread-lifecycle-fixes.md). A hidden child
// (InSidebar false) is reached through its creator: the creator's Threads tab, its
// wakes. Once the creator is removed nothing leads to it, yet it may still be working.
// So removing a thread hands its children to the user: each one not archived gets the
// sidebar override (shown), and nothing is stopped. Threads whose creator was removed
// before this rule (or by a daemon that crashed in between) get the same at load.

// adoptOrphansLocked shows in the sidebar the threads creator created that are not
// archived, not being removed, and not shown by an override already; creator is being
// removed. Callers hold m.mu.
func (m *Manager) adoptOrphansLocked(creator string) {
	for _, rec := range m.recs {
		if rec.s.CreatedBy != creator || !orphanToAdopt(rec.s) {
			continue
		}
		rec.s.SidebarOverride = sidebarOverride(true)
		m.commitLocked(rec, true)
		m.log.Info("thread shown in the sidebar: its creator was removed", "thread", rec.s.ID, "created_by", creator)
	}
}

// orphanToAdopt reports whether s, whose creator is gone, is to be shown in the sidebar.
func orphanToAdopt(s Thread) bool {
	shown := s.SidebarOverride != nil && *s.SidebarOverride
	return s.CreatedBy != "" && !shown && s.ArchivedAt.IsZero() && !s.Removing
}

// adoptLoadedOrphans is adoptOrphansLocked at load, for every creator that is gone:
// rows is every thread loaded. The changed rows are saved and returned in place.
func adoptLoadedOrphans(ctx context.Context, m *Manager, rows []Thread) error {
	known := make(map[string]bool, len(rows))
	for _, s := range rows {
		known[s.ID] = true
	}
	for i, s := range rows {
		if known[s.CreatedBy] || !orphanToAdopt(s) {
			continue
		}
		s.SidebarOverride = sidebarOverride(true)
		if err := saveThread(ctx, m.opts.DB, s); err != nil {
			return err
		}
		rows[i] = s
		m.log.Info("thread shown in the sidebar: its creator was removed", "thread", s.ID, "created_by", s.CreatedBy)
	}
	return nil
}
