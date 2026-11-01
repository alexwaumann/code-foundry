package thread

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestInSidebar(t *testing.T) {
	threads := []Thread{{ID: "p"}, {ID: "archived", ArchivedAt: time.Unix(9, 0)}, {ID: "c", CreatedBy: "p"}}
	tests := []struct {
		name string
		t    Thread
		want bool
	}{
		{name: "the user's thread", t: Thread{ID: "u"}, want: true},
		{name: "a thread whose creator exists is hidden", t: Thread{ID: "c", CreatedBy: "p"}, want: false},
		{name: "an archived creator still exists", t: Thread{ID: "c2", CreatedBy: "archived"}, want: false},
		{name: "a creator that is itself hidden still exists", t: Thread{ID: "g", CreatedBy: "c"}, want: false},
		{name: "a thread whose creator was removed is shown", t: Thread{ID: "o", CreatedBy: "gone"}, want: true},
	}
	exists := Known(threads)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.t.InSidebar(exists); got != tt.want {
				t.Errorf("InSidebar = %v, want %v", got, tt.want)
			}
		})
	}
}

// cascadeTree is root r with:
//
//	a                 a1 (under a)
//	c  archived       c1 (under c)
//	o  created by a removed thread, o1 under it (not under r)
//	u  the user's (no creator; never in the tree)
func cascadeTree() []Thread {
	at := func(min int) time.Time { return time.Unix(0, 0).Add(time.Duration(min) * time.Minute) }
	return []Thread{
		{ID: "r", CreatedAt: at(0)},
		{ID: "a", CreatedBy: "r", CreatedAt: at(1)},
		{ID: "a1", CreatedBy: "a", CreatedAt: at(2)},
		{ID: "c", CreatedBy: "r", CreatedAt: at(5), ArchivedAt: at(9)},
		{ID: "c1", CreatedBy: "c", CreatedAt: at(6)},
		{ID: "o", CreatedBy: "gone", CreatedAt: at(7)},
		{ID: "o1", CreatedBy: "o", CreatedAt: at(8)},
		{ID: "u", CreatedAt: at(10)},
	}
}

func TestArchiveCascade(t *testing.T) {
	tests := []struct {
		name    string
		threads []Thread
		root    string
		want    []string // id@depth
	}{
		{name: "every thread below, through archived ones", threads: cascadeTree(), root: "r",
			want: []string{"a@1", "a1@2", "c@1", "c1@2"}},
		{name: "below a hidden thread", threads: cascadeTree(), root: "a", want: []string{"a1@1"}},
		{name: "a thread whose creator was removed takes its own", threads: cascadeTree(), root: "o", want: []string{"o1@1"}},
		{name: "a leaf has none", threads: cascadeTree(), root: "a1"},
		{name: "a removed root has none: its children are shown", threads: cascadeTree(), root: "gone"},
		{name: "no root", threads: cascadeTree(), root: ""},
		{name: "a creator cycle is cut", root: "x", threads: []Thread{
			{ID: "x", CreatedBy: "y"}, {ID: "y", CreatedBy: "x", CreatedAt: time.Unix(1, 0)},
		}, want: []string{"y@1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, th := range ArchiveCascade(tt.threads, tt.root) {
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
			want: []string{"a", "a1", "c1"}},
		{name: "include archived", o: ListOptions{ArchiveCascadeOf: "r", IncludeArchived: true},
			want: []string{"a", "a1", "c", "c1"}},
		{name: "composes with created-by", o: ListOptions{ArchiveCascadeOf: "r", CreatedBy: "r"}, want: []string{"a"}},
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

// TestArchiveCascadeManager: archiving a thread archives every thread below it (closing
// the live ones); unarchiving does not cascade.
func TestArchiveCascadeManager(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	grand := e.connected(CreateOptions{Name: "grand", CreatedBy: child.ID})
	other := e.connected(CreateOptions{Name: "other"})

	listed, err := e.m.List(e.ctx(), ListOptions{ArchiveCascadeOf: parent.ID})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(listed); !slices.Equal(got, []string{child.ID, grand.ID}) {
		t.Errorf("List(ArchiveCascadeOf) = %v, want %v", got, []string{child.ID, grand.ID})
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
	for _, s := range []Thread{child, grand} {
		if a := e.snapshot(s.ID); a.ArchivedAt.IsZero() || a.State != StateDisconnected {
			t.Errorf("%s: archived %v, state %s; want archived and disconnected", s.Name, a.ArchivedAt, a.State)
		}
		if a := e.snapshot(s.ID); a.ArchivedAt.After(got.ArchivedAt) {
			t.Errorf("%s archived at %v, after its root (%v)", s.Name, a.ArchivedAt, got.ArchivedAt)
		}
	}
	if a := e.snapshot(other.ID); !a.ArchivedAt.IsZero() || a.State != StateConnected {
		t.Errorf("other: archived %v, state %s; want untouched", a.ArchivedAt, a.State)
	}

	if _, err := e.m.Archive(e.ctx(), parent.ID, false); err != nil {
		t.Fatal(err)
	}
	if a := e.snapshot(child.ID); a.ArchivedAt.IsZero() {
		t.Error("unarchiving the parent unarchived its child")
	}
}

// Removing a thread removes every thread below it (ArchiveCascade): a live child and its
// grandchild are closed and forgotten, an archived child too; nothing else is touched.
func TestRemoveCascadesThroughChildren(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	child := e.connected(CreateOptions{Name: "child", CreatedBy: parent.ID})
	grand := e.connected(CreateOptions{Name: "grand", CreatedBy: child.ID})
	archived := e.connected(CreateOptions{Name: "archived", CreatedBy: parent.ID})
	if _, err := e.m.Archive(e.ctx(), archived.ID, true); err != nil {
		t.Fatal(err)
	}
	other := e.connected(CreateOptions{Name: "other"})
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
	if s := e.snapshot(other.ID); s.State != StateConnected || s.Removing {
		t.Errorf("other: state %v, removing %v; want still connected", s.State, s.Removing)
	}
	e.restart()
	if _, err := e.m.Get(e.ctx(), child.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("the child came back after a restart: %v", err)
	}
}

// A thread whose creator no longer exists (a removal's cascade failed on it, or an older
// daemon removed the creator without one) is shown in the sidebar, derived at load with
// nothing stored, and a later cascade from elsewhere does not reach it.
func TestCreatorGoneIsShown(t *testing.T) {
	e := newEnv(t)
	parent := e.connected(CreateOptions{Name: "parent"})
	if err := saveThread(e.ctx(), e.m.opts.DB, Thread{ID: "s-orphan", Name: "orphan", WorktreePath: e.wt,
		CreatedBy: "s-gone", CreatedAt: time.Unix(1, 0), State: StateDisconnected}); err != nil {
		t.Fatal(err)
	}
	e.restart()
	snap := e.m.Snapshot()
	o, ok := snap.Thread("s-orphan")
	if !ok {
		t.Fatal("the orphan was not loaded")
	}
	if !o.InSidebar(Known(snap.Threads)) {
		t.Error("a thread whose creator is gone is not in the sidebar")
	}
	if got := ArchiveCascade(snap.Threads, parent.ID); len(got) != 0 {
		t.Errorf("ArchiveCascade(parent) = %v, want none", ids(got))
	}
}

func ids(threads []Thread) []string {
	out := make([]string, len(threads))
	for i, t := range threads {
		out[i] = t.ID
	}
	return out
}
