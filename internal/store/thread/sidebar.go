package thread

// The sidebar rule (docs/notes/no-sidebar-override-2-daemon.md). A thread another thread
// created (CreatedBy) is its creator's, not the user's: it is not in the GUI's sidebar
// or the Dock badge, archiving or removing its creator takes it along (archive.go,
// ArchiveCascade), and it is reached through its creator (the thread info card, the
// palette, links). Nothing shows one: to take its work over the user forks it. Once its
// creator no longer exists (removed; an archived creator still exists) nothing leads to
// it, so it is shown. Nothing is stored for it: the GUI derives the same rule from the
// thread list.

// InSidebar reports whether the thread is in the sidebar: it has no creator, or its
// creator does not exist (exists, e.g. Known over the snapshot's threads, says no).
func (t Thread) InSidebar(exists func(id string) bool) bool {
	return t.CreatedBy == "" || !exists(t.CreatedBy)
}

// Known is InSidebar's exists over threads: whether a thread with that id is among them.
func Known(threads []Thread) func(id string) bool {
	ids := make(map[string]struct{}, len(threads))
	for _, t := range threads {
		ids[t.ID] = struct{}{}
	}
	return func(id string) bool {
		_, ok := ids[id]
		return ok
	}
}

// ArchiveCascade returns the threads below root that archiving root takes with it
// (ListOptions.ArchiveCascadeOf): Subtree's walk (tree order, MaxLineageDepth, cycle
// safe) over threads, each with its Depth; root itself is not listed. Every thread the
// walk reaches is hidden, its creator being the thread above it, so that is the whole
// subtree of live threads; nothing when root is not among threads. Archived threads are
// walked through and listed: a caller that archives skips them.
func ArchiveCascade(threads []Thread, root string) []Thread {
	if root == "" {
		return nil
	}
	byID := make(map[string]Thread, len(threads))
	for _, t := range threads {
		byID[t.ID] = t
	}
	if _, ok := byID[root]; !ok {
		return nil
	}
	var out []Thread
	for _, e := range Subtree(lineageNodes(threads, nil), root) {
		t, ok := byID[e.ID]
		if e.Depth == 0 || !ok {
			continue
		}
		t.Depth = e.Depth
		out = append(out, t)
	}
	return out
}
