package thread

import (
	"context"
	"fmt"
)

// Hidden children (docs/notes/hidden-children-1-daemon.md). A thread another thread
// created (CreatedBy) is managed by its creator, not the user, so by default it is not
// shown in the GUI's sidebar: the threads.show_created_threads setting (default off)
// shows them all, and a per-thread override (Thread.SidebarOverride, Store.SetSidebar,
// CreateOptions.InSidebar) shows or hides one whatever the setting says. A shown thread
// is the user's to manage; a hidden one is its creator's: it stays out of the sidebar
// and the Dock badge, and archiving its creator archives it too (archive.go,
// ArchiveCascade). The GUI reimplements InSidebar from created_by, in_sidebar and the
// setting. A thread whose creator was removed is shown by its override, set by the
// removal (or at load for older data: orphans.go), so neither needs the creator.

// InSidebar is the thread's effective visibility in the sidebar given the
// threads.show_created_threads setting: a thread no thread created is always shown; a
// thread with an override follows it; any other follows the setting.
func (t Thread) InSidebar(showCreated bool) bool {
	switch {
	case t.CreatedBy == "":
		return true
	case t.SidebarOverride != nil:
		return *t.SidebarOverride
	}
	return showCreated
}

// sidebarOverride is a fresh *bool for v: Thread.SidebarOverride is shared by
// snapshots, so it is replaced, never written through.
func sidebarOverride(v bool) *bool { return &v }

// checkSidebarOverride refuses an override on a thread no thread created: it is always
// shown, the user's own.
func checkSidebarOverride(createdBy string, override *bool) error {
	if override != nil && createdBy == "" {
		return fmt.Errorf("%w: only a thread another thread created can be shown or hidden in the sidebar; one the user created is always shown", ErrInvalidArgument)
	}
	return nil
}

// SetShowCreatedThreads sets the threads.show_created_threads setting the store reads
// (InSidebar's showCreated) for the archive cascade. The daemon calls it now and on
// every settings change. Nothing is republished: the GUI applies the setting itself.
func (m *Manager) SetShowCreatedThreads(show bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.showCreated = show
}

// showCreatedThreads is the setting in effect.
func (m *Manager) showCreatedThreads() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.showCreated
}

// SetSidebar shows (true) or hides (false) a thread another thread created in the
// sidebar, overriding the setting for it; ErrInvalidArgument for the user's own thread.
// Any state. Persisted.
func (m *Manager) SetSidebar(_ context.Context, id string, shown bool) (Thread, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, err := m.record(id)
	if err != nil {
		return Thread{}, err
	}
	if err := checkSidebarOverride(rec.s.CreatedBy, &shown); err != nil {
		return Thread{}, fmt.Errorf("thread %s: %w", id, err)
	}
	if o := rec.s.SidebarOverride; o != nil && *o == shown {
		return rec.s, nil
	}
	rec.s.SidebarOverride = sidebarOverride(shown)
	m.commitLocked(rec, true)
	m.log.Info("thread sidebar override", "thread", id, "shown", shown)
	return rec.s, nil
}

// ArchiveCascade returns the threads below root that archiving root takes with it
// (ListOptions.ArchiveCascadeOf): Subtree's walk (tree order, MaxLineageDepth, cycle
// safe) through hidden threads only. A thread shown in the sidebar (InSidebar with
// showCreated) is left out with everything below it; root itself is not listed. Hidden
// archived threads are walked through and listed, each with its Depth: a caller that
// archives skips them.
func ArchiveCascade(threads []Thread, root string, showCreated bool) []Thread {
	if root == "" {
		return nil
	}
	byID := make(map[string]Thread, len(threads))
	for _, t := range threads {
		byID[t.ID] = t
	}
	var out []Thread
	cut := -1 // the depth of the shown thread whose subtree is being skipped; -1: none
	for _, e := range Subtree(lineageNodes(threads, nil), root) {
		if e.Depth == 0 {
			continue
		}
		if cut >= 0 && e.Depth > cut {
			continue
		}
		cut = -1
		t, ok := byID[e.ID]
		if !ok {
			continue
		}
		if t.InSidebar(showCreated) {
			cut = e.Depth
			continue
		}
		t.Depth = e.Depth
		out = append(out, t)
	}
	return out
}
