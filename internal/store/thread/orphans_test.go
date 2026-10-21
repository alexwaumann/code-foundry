package thread

import (
	"testing"
)

// Removing a thread shows its children that are not archived in the sidebar, live ones
// still running; an archived child and a grandchild (its creator is still there) are
// left as they were. A child whose creator went without that (an older daemon) is
// shown at load.
func TestRemoveShowsItsChildren(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	grand := e.connected(CreateOptions{Name: "grand", CreatedBy: child.ID})
	archived := e.connected(CreateOptions{Name: "archived", CreatedBy: parent.ID})
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Remove(e.ctx(), parent.ID); err != nil {
		t.Fatal(err)
	}
	shown := func(id string) bool { s := e.snapshot(id); return s.SidebarOverride != nil && *s.SidebarOverride }
	if s := e.snapshot(child.ID); !shown(child.ID) || !s.InSidebar(false) || s.State != StateConnected {
		t.Errorf("the live child: override %v, state %v; want shown and still connected", s.SidebarOverride, s.State)
	}
	for _, id := range []string{grand.ID, archived.ID} {
		if s := e.snapshot(id); s.SidebarOverride != nil {
			t.Errorf("%s: override %v, want unset", s.Name, *s.SidebarOverride)
		}
	}
	e.restart()
	if !shown(child.ID) {
		t.Error("the child's override did not survive a restart")
	}

	// As an older daemon left it: the creator gone, the child still hidden.
	if _, err := e.m.SetSidebar(e.ctx(), child.ID, false); err != nil {
		t.Fatal(err)
	}
	e.restart()
	if !shown(child.ID) {
		t.Error("a hidden child whose creator is gone was not shown at load")
	}
	if s := e.snapshot(archived.ID); s.SidebarOverride != nil {
		t.Errorf("the archived child at load: override %v, want unset", *s.SidebarOverride)
	}
}
