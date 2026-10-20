package thread

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestInSidebar(t *testing.T) {
	yes, no := true, false
	tests := []struct {
		name        string
		t           Thread
		showCreated bool
		want        bool
	}{
		{name: "the user's thread, setting off", t: Thread{}, want: true},
		{name: "the user's thread, setting on", t: Thread{}, showCreated: true, want: true},
		{name: "a created thread follows the setting off", t: Thread{CreatedBy: "p"}, want: false},
		{name: "a created thread follows the setting on", t: Thread{CreatedBy: "p"}, showCreated: true, want: true},
		{name: "shown by its override, setting off", t: Thread{CreatedBy: "p", SidebarOverride: &yes}, want: true},
		{name: "hidden by its override, setting on", t: Thread{CreatedBy: "p", SidebarOverride: &no}, showCreated: true, want: false},
		{name: "an override on a user's thread is ignored", t: Thread{SidebarOverride: &no}, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.t.InSidebar(tt.showCreated); got != tt.want {
				t.Errorf("InSidebar(%v) = %v, want %v", tt.showCreated, got, tt.want)
			}
		})
	}
}

// cascadeTree is root r with:
//
//	a  hidden        a1 hidden (under a)
//	b  shown (override)   b1 hidden (under b: not reached)
//	c  hidden, archived   c1 hidden (under c)
//	d  no override (follows the setting)   d1 hidden (under d)
//	u  the user's (no creator; never in the tree)
func cascadeTree() []Thread {
	yes, no := true, false
	at := func(min int) time.Time { return time.Unix(0, 0).Add(time.Duration(min) * time.Minute) }
	return []Thread{
		{ID: "r", CreatedAt: at(0)},
		{ID: "a", CreatedBy: "r", CreatedAt: at(1), SidebarOverride: &no},
		{ID: "a1", CreatedBy: "a", CreatedAt: at(2)},
		{ID: "b", CreatedBy: "r", CreatedAt: at(3), SidebarOverride: &yes},
		{ID: "b1", CreatedBy: "b", CreatedAt: at(4)},
		{ID: "c", CreatedBy: "r", CreatedAt: at(5), ArchivedAt: at(9)},
		{ID: "c1", CreatedBy: "c", CreatedAt: at(6)},
		{ID: "d", CreatedBy: "r", CreatedAt: at(7)},
		{ID: "d1", CreatedBy: "d", CreatedAt: at(8), SidebarOverride: &no},
		{ID: "u", CreatedAt: at(10)},
	}
}

func TestArchiveCascade(t *testing.T) {
	tests := []struct {
		name        string
		threads     []Thread
		root        string
		showCreated bool
		want        []string // id@depth
	}{
		{name: "setting off: every hidden thread, through hidden ones; shown b stops its branch", threads: cascadeTree(), root: "r",
			want: []string{"a@1", "a1@2", "c@1", "c1@2", "d@1", "d1@2"}},
		{name: "setting on: only overrides hide; c, d and a1 are shown and stop their branches", threads: cascadeTree(), root: "r", showCreated: true,
			want: []string{"a@1"}},
		{name: "below a hidden thread", threads: cascadeTree(), root: "a", want: []string{"a1@1"}},
		{name: "a shown root still takes its hidden children", threads: cascadeTree(), root: "b", want: []string{"b1@1"}},
		{name: "a leaf has none", threads: cascadeTree(), root: "a1"},
		{name: "unknown root", threads: cascadeTree(), root: "nope"},
		{name: "no root", threads: cascadeTree(), root: ""},
		{name: "a creator cycle is cut", root: "x", threads: []Thread{
			{ID: "x", CreatedBy: "y"}, {ID: "y", CreatedBy: "x", CreatedAt: time.Unix(1, 0)},
		}, want: []string{"y@1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, th := range ArchiveCascade(tt.threads, tt.root, tt.showCreated) {
				got = append(got, th.ID+"@"+string(rune('0'+th.Depth)))
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("ArchiveCascade = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestFilterArchiveCascade(t *testing.T) {
	tests := []struct {
		name string
		o    ListOptions
		want []string
	}{
		{name: "archived ones left out by default (c), its child kept", o: ListOptions{ArchiveCascadeOf: "r"},
			want: []string{"a", "a1", "c1", "d", "d1"}},
		{name: "include archived", o: ListOptions{ArchiveCascadeOf: "r", IncludeArchived: true},
			want: []string{"a", "a1", "c", "c1", "d", "d1"}},
		{name: "with the setting", o: ListOptions{ArchiveCascadeOf: "r", ShowCreated: true}, want: []string{"a"}},
		{name: "composes with created-by", o: ListOptions{ArchiveCascadeOf: "r", CreatedBy: "r"}, want: []string{"a", "d"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, th := range FilterThreads(cascadeTree(), tt.o) {
				got = append(got, th.ID)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("FilterThreads = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCascadeError(t *testing.T) {
	one := &CascadeError{ID: "p", Failed: []CascadeFailure{{ID: "c", Err: errors.New("boom")}}}
	if got, want := one.Error(), "archived thread p, but 1 hidden thread below it was not archived: c: boom"; got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
	two := &CascadeError{ID: "p", Failed: []CascadeFailure{{ID: "c", Err: errors.New("boom")}, {ID: "d", Err: errors.New("bang")}}}
	if got := two.Error(); !strings.Contains(got, "2 hidden threads below it were not archived: c: boom; d: bang") {
		t.Errorf("Error() = %q", got)
	}
	if !errors.Is(two, ErrFailedPrecondition) {
		t.Error("a CascadeError is not an ErrFailedPrecondition")
	}
}

func TestSetSidebar(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	if child.SidebarOverride != nil || child.InSidebar(false) {
		t.Fatalf("a new child: override %v, shown %v; want unset and hidden", child.SidebarOverride, child.InSidebar(false))
	}
	if _, err := e.m.SetSidebar(e.ctx(), parent.ID, true); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("SetSidebar on the user's thread: %v, want ErrInvalidArgument", err)
	}
	if _, err := e.m.SetSidebar(e.ctx(), "s-nope", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetSidebar on an unknown thread: %v, want ErrNotFound", err)
	}
	got, err := e.m.SetSidebar(e.ctx(), child.ID, true)
	if err != nil || got.SidebarOverride == nil || !*got.SidebarOverride || !got.InSidebar(false) {
		t.Fatalf("SetSidebar(true) = %+v, %v", got.SidebarOverride, err)
	}
	e.waitEvent(e.events, child.ID, "the override published", func(s Thread) bool { return s.SidebarOverride != nil && *s.SidebarOverride })
	e.restart()
	if s := e.snapshot(child.ID); s.SidebarOverride == nil || !*s.SidebarOverride {
		t.Errorf("after a restart: override %v, want true", s.SidebarOverride)
	}
	if s := e.snapshot(parent.ID); s.SidebarOverride != nil {
		t.Errorf("the parent after a restart: override %v, want unset", s.SidebarOverride)
	}
	if got, err := e.m.SetSidebar(e.ctx(), child.ID, false); err != nil || got.InSidebar(true) {
		t.Fatalf("SetSidebar(false) = %+v, %v", got.SidebarOverride, err)
	}
	e.restart()
	if s := e.snapshot(child.ID); s.SidebarOverride == nil || *s.SidebarOverride {
		t.Errorf("after a restart: override %v, want false", s.SidebarOverride)
	}
}

func TestCreateInSidebar(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	yes := true
	if _, err := e.m.Create(e.ctx(), CreateOptions{WorktreePath: e.wt, Name: "mine", InSidebar: &yes}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("Create with InSidebar and no creator: %v, want ErrInvalidArgument", err)
	}
	s := e.connected(CreateOptions{Name: "handed over", CreatedBy: parent.ID, InSidebar: &yes})
	if s.SidebarOverride == nil || !*s.SidebarOverride {
		t.Fatalf("override = %v, want true", s.SidebarOverride)
	}
	yes = false // the store keeps its own copy
	if got := e.snapshot(s.ID); got.SidebarOverride == nil || !*got.SidebarOverride {
		t.Errorf("override after the caller's bool changed = %v, want true", got.SidebarOverride)
	}
	e.restart()
	if got := e.snapshot(s.ID); got.SidebarOverride == nil || !*got.SidebarOverride {
		t.Errorf("after a restart: override %v, want true", got.SidebarOverride)
	}
}

// TestArchiveCascadeManager: archiving a thread archives the hidden threads below it
// (closing the live ones) and stops at a shown one; unarchiving does not cascade; the
// setting shows created threads, which then stay.
func TestArchiveCascadeManager(t *testing.T) {
	e := newEnv(t)
	yes := true
	parent := e.connected(CreateOptions{Name: "parent"})
	hidden := e.connected(CreateOptions{Name: "hidden", CreatedBy: parent.ID})
	grand := e.connected(CreateOptions{Name: "grand", CreatedBy: hidden.ID})
	shown := e.connected(CreateOptions{Name: "shown", CreatedBy: parent.ID, InSidebar: &yes})
	under := e.connected(CreateOptions{Name: "under shown", CreatedBy: shown.ID})
	other := e.connected(CreateOptions{Name: "other"})

	listed, err := e.m.List(e.ctx(), ListOptions{ArchiveCascadeOf: parent.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(listed); !slices.Equal(got, []string{hidden.ID, grand.ID}) {
		t.Errorf("List(ArchiveCascadeOf) = %v, want %v", got, []string{hidden.ID, grand.ID})
	}
	if _, err := e.m.List(e.ctx(), ListOptions{ArchiveCascadeOf: parent.ID, DescendantsOf: parent.ID}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("List with both: %v, want ErrInvalidArgument", err)
	}

	got, err := e.m.Archive(e.ctx(), parent.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.ArchivedAt.IsZero() {
		t.Error("the parent is not archived")
	}
	for _, s := range []Thread{hidden, grand} {
		if a := e.snapshot(s.ID); a.ArchivedAt.IsZero() || a.State != StateDisconnected {
			t.Errorf("%s: archived %v, state %s; want archived and disconnected", s.Name, a.ArchivedAt, a.State)
		}
		if a := e.snapshot(s.ID); a.ArchivedAt.After(got.ArchivedAt) {
			t.Errorf("%s archived at %v, after its root (%v)", s.Name, a.ArchivedAt, got.ArchivedAt)
		}
	}
	for _, s := range []Thread{shown, under, other} {
		if a := e.snapshot(s.ID); !a.ArchivedAt.IsZero() || a.State != StateConnected {
			t.Errorf("%s: archived %v, state %s; want untouched", s.Name, a.ArchivedAt, a.State)
		}
	}

	if _, err := e.m.Archive(e.ctx(), parent.ID, false); err != nil {
		t.Fatal(err)
	}
	if a := e.snapshot(hidden.ID); a.ArchivedAt.IsZero() {
		t.Error("unarchiving the parent unarchived its hidden child")
	}

	// With the setting on, a created thread without an override is shown: it stays.
	e.m.SetShowCreatedThreads(true)
	lead := e.connected(CreateOptions{Name: "lead"})
	worker := e.connected(CreateOptions{Name: "worker", CreatedBy: lead.ID})
	if _, err := e.m.Archive(e.ctx(), lead.ID, true); err != nil {
		t.Fatal(err)
	}
	if a := e.snapshot(worker.ID); !a.ArchivedAt.IsZero() {
		t.Error("the setting shows created threads, yet the worker was archived with its lead")
	}
}

func ids(threads []Thread) []string {
	out := make([]string, len(threads))
	for i, t := range threads {
		out[i] = t.ID
	}
	return out
}
