package thread

import (
	"errors"
	"slices"
	"testing"
	"time"
)

func TestFilterThreads(t *testing.T) {
	t0 := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	threads := []Thread{
		{ID: "s-a", CreatedAt: at(0), LastActivityAt: at(10), Status: StatusBusy, State: StateConnected, ProjectID: "r1", Labels: []string{"api", "x"}},
		{ID: "s-b", CreatedAt: at(1), LastActivityAt: at(30), Status: StatusIdle, State: StateDisconnected, ProjectID: "r2", CreatedBy: "s-a"},
		{ID: "s-c", CreatedAt: at(2), Status: StatusNeedsAttention, State: StateConnected, WorkspaceID: "w-1", ProjectID: "r1", CreatedBy: "s-a", Labels: []string{"api"}},
		{ID: "s-d", CreatedAt: at(3), LastActivityAt: at(40), Status: StatusError, State: StateDisconnected, ArchivedAt: at(41), CreatedBy: "s-b", Labels: []string{"arch", "x"}},
		{ID: "s-e", CreatedAt: at(4), LastActivityAt: at(30), Status: StatusIdle, State: StateDisconnected},
	}
	tests := []struct {
		name string
		o    ListOptions
		want []string
	}{
		// s-b and s-e were both last active at 30: the newer created first. s-c never
		// was active: its creation counts.
		{name: "default leaves archived out, newest activity first", want: []string{"s-e", "s-b", "s-a", "s-c"}},
		{name: "archived included", o: ListOptions{IncludeArchived: true}, want: []string{"s-d", "s-e", "s-b", "s-a", "s-c"}},
		{name: "all includes archived", o: ListOptions{All: true}, want: []string{"s-d", "s-e", "s-b", "s-a", "s-c"}},
		// All composes with the other filters (it used to ignore them).
		{name: "all and a project nothing is in", o: ListOptions{All: true, Status: StatusBusy, Project: "r9"}, want: nil},
		{name: "all and a label", o: ListOptions{All: true, Labels: []string{"arch"}}, want: []string{"s-d"}},
		{name: "all and a status", o: ListOptions{All: true, Status: StatusError}, want: []string{"s-d"}},
		{name: "all and created by a thread", o: ListOptions{All: true, CreatedBy: "s-b"}, want: []string{"s-d"}},
		{name: "all and created by the user", o: ListOptions{All: true, CreatedBy: CreatedByUser}, want: []string{"s-e", "s-a"}},
		{name: "all and a label an archived and a live thread carry", o: ListOptions{All: true, Labels: []string{"x"}}, want: []string{"s-d", "s-a"}},
		{name: "all keeps the limit", o: ListOptions{All: true, Limit: 2}, want: []string{"s-d", "s-e"}},
		{name: "status", o: ListOptions{Status: StatusIdle}, want: []string{"s-e", "s-b"}},
		{name: "status of an archived thread needs archived", o: ListOptions{Status: StatusError}, want: nil},
		{name: "state", o: ListOptions{State: StateConnected}, want: []string{"s-a", "s-c"}},
		{name: "project", o: ListOptions{Project: "r1"}, want: []string{"s-a", "s-c"}},
		{name: "workspace", o: ListOptions{Workspace: "w-1"}, want: []string{"s-c"}},
		{name: "created by a thread", o: ListOptions{CreatedBy: "s-a"}, want: []string{"s-b", "s-c"}},
		{name: "created by the user", o: ListOptions{CreatedBy: CreatedByUser}, want: []string{"s-e", "s-a"}},
		{name: "one label", o: ListOptions{Labels: []string{"api"}}, want: []string{"s-a", "s-c"}},
		{name: "every label, any case", o: ListOptions{Labels: []string{"API", " x "}}, want: []string{"s-a"}},
		{name: "limit", o: ListOptions{Limit: 1}, want: []string{"s-e"}},
		{name: "filters combine", o: ListOptions{Project: "r1", Labels: []string{"api"}, Status: StatusNeedsAttention}, want: []string{"s-c"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, th := range FilterThreads(threads, tt.o) {
				got = append(got, th.ID)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("FilterThreads = %v, want %v", got, tt.want)
			}
		})
	}
}

// List resolves a project by name or path and a workspace by name; refs naming nothing
// are invalid arguments.
func TestListResolvesRefs(t *testing.T) {
	e := newEnv(t)
	s := e.create(CreateOptions{ProjectID: "r1", Labels: []string{"api"}})
	for _, ref := range []string{"r1", "repo", e.wt} {
		got, err := e.m.List(e.ctx(), ListOptions{Project: ref})
		if err != nil || len(got) != 1 || got[0].ID != s.ID {
			t.Errorf("List(project %q) = %v, %v", ref, got, err)
		}
	}
	if got, err := e.m.List(e.ctx(), ListOptions{Labels: []string{"other"}}); err != nil || len(got) != 0 {
		t.Errorf("List(label other) = %v, %v", got, err)
	}
	for _, o := range []ListOptions{{Project: "nope"}, {Workspace: "nope"}} {
		if _, err := e.m.List(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("List(%+v) err = %v, want ErrInvalidArgument", o, err)
		}
	}
	// All composes with the refs: they are resolved, and one naming nothing is still invalid.
	if got, err := e.m.List(e.ctx(), ListOptions{All: true}); err != nil || len(got) != 1 {
		t.Errorf("List(all) = %v, %v", got, err)
	}
	if got, err := e.m.List(e.ctx(), ListOptions{All: true, Project: "repo"}); err != nil || len(got) != 1 || got[0].ID != s.ID {
		t.Errorf("List(all, project repo) = %v, %v", got, err)
	}
	for _, o := range []ListOptions{{All: true, Project: "nope"}, {All: true, Workspace: "nope"}} {
		if _, err := e.m.List(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("List(%+v) err = %v, want ErrInvalidArgument", o, err)
		}
	}
}
