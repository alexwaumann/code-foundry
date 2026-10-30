package thread

import (
	"errors"
	"testing"
)

// Removing a thread removes the hidden threads below it with it, through hidden threads
// only (ArchiveCascade): a live hidden child and its grandchild are closed and forgotten,
// an archived hidden child too. A child shown in the sidebar stays with everything below
// it, still running. A child whose creator went without that (an older daemon) is shown
// at load (orphans.go).
func TestRemoveCascadesThroughHiddenChildren(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	grand := e.connected(CreateOptions{Name: "grand", CreatedBy: child.ID})
	archived := e.connected(CreateOptions{Name: "archived", CreatedBy: parent.ID})
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	shownKid := e.connected(CreateOptions{Name: "shown", CreatedBy: parent.ID})
	if _, err := e.m.SetSidebar(e.ctx(), shownKid.ID, true); err != nil {
		t.Fatal(err)
	}
	shownGrand := e.connected(CreateOptions{Name: "shown's kid", CreatedBy: shownKid.ID})
	if err := e.m.Remove(e.ctx(), parent.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{parent.ID, child.ID, grand.ID, archived.ID} {
		if _, err := e.m.Get(e.ctx(), id); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s after the removal: err %v, want gone", id, err)
		}
		if _, ok := e.m.removed.get(id, e.m.opts.Now()); !ok {
			t.Errorf("%s: no tombstone", id)
		}
	}
	if s := e.snapshot(shownKid.ID); s.State != StateConnected || s.Removing {
		t.Errorf("the shown child: state %v, removing %v; want still connected", s.State, s.Removing)
	}
	if s := e.snapshot(shownGrand.ID); s.State != StateConnected || s.SidebarOverride != nil {
		t.Errorf("the shown child's child: state %v, override %v; want still connected, unset", s.State, s.SidebarOverride)
	}
	e.restart()
	if _, err := e.m.Get(e.ctx(), child.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("the child came back after a restart: %v", err)
	}

	// As an older daemon left it: a creator gone, its child still hidden (made here by
	// removing the creator while created threads are shown, so nothing cascades, then
	// hiding the child). It is shown at load; an archived one is left as it was.
	creator := e.connected(CreateOptions{Name: "creator"})
	orphan := e.connected(CreateOptions{Name: "orphan", CreatedBy: creator.ID})
	orphanArchived := e.connected(CreateOptions{Name: "orphan archived", CreatedBy: creator.ID})
	if _, err := e.m.Archive(e.ctx(), orphanArchived.ID, true); err != nil {
		t.Fatal(err)
	}
	e.m.SetShowCreatedThreads(true)
	if err := e.m.Remove(e.ctx(), creator.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.SetSidebar(e.ctx(), orphan.ID, false); err != nil {
		t.Fatal(err)
	}
	e.restart()
	if s := e.snapshot(orphan.ID); s.SidebarOverride == nil || !*s.SidebarOverride {
		t.Error("a hidden child whose creator is gone was not shown at load")
	}
	if s := e.snapshot(orphanArchived.ID); s.SidebarOverride != nil {
		t.Errorf("the archived orphan at load: override %v, want unset", *s.SidebarOverride)
	}
}

// With threads.show_created_threads on, every child is shown: a removal takes none with
// it, and nothing is adopted (no override is needed).
func TestRemoveWithCreatedThreadsShown(t *testing.T) {
	e := newEnv(t)
	e.m.SetShowCreatedThreads(true)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	if err := e.m.Remove(e.ctx(), parent.ID); err != nil {
		t.Fatal(err)
	}
	if s := e.snapshot(child.ID); s.State != StateConnected || !s.InSidebar(true) {
		t.Errorf("the child: state %v, in sidebar %v; want connected and shown", s.State, s.InSidebar(true))
	}
}
