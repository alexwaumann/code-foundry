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
		{ID: "s-a", CreatedAt: at(0), LastActivityAt: at(10), Status: StatusBusy, State: StateConnected, RepoID: "r1", Labels: []string{"api", "x"}},
		{ID: "s-b", CreatedAt: at(1), LastActivityAt: at(30), Status: StatusIdle, State: StateDisconnected, RepoID: "r2", CreatedBy: "s-a"},
		{ID: "s-c", CreatedAt: at(2), Status: StatusNeedsAttention, State: StateConnected, WorkspaceID: "w-1", RepoID: "r1", CreatedBy: "s-a", Labels: []string{"api"}},
		{ID: "s-d", CreatedAt: at(3), LastActivityAt: at(40), Status: StatusError, State: StateDisconnected, ArchivedAt: at(41), CreatedBy: "s-b"},
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
		{name: "all ignores the filters", o: ListOptions{All: true, Status: StatusBusy, Repo: "r9"}, want: []string{"s-d", "s-e", "s-b", "s-a", "s-c"}},
		{name: "all keeps the limit", o: ListOptions{All: true, Limit: 2}, want: []string{"s-d", "s-e"}},
		{name: "status", o: ListOptions{Status: StatusIdle}, want: []string{"s-e", "s-b"}},
		{name: "status of an archived thread needs archived", o: ListOptions{Status: StatusError}, want: nil},
		{name: "state", o: ListOptions{State: StateConnected}, want: []string{"s-a", "s-c"}},
		{name: "repo", o: ListOptions{Repo: "r1"}, want: []string{"s-a", "s-c"}},
		{name: "workspace", o: ListOptions{Workspace: "w-1"}, want: []string{"s-c"}},
		{name: "created by a thread", o: ListOptions{CreatedBy: "s-a"}, want: []string{"s-b", "s-c"}},
		{name: "created by the user", o: ListOptions{CreatedBy: CreatedByUser}, want: []string{"s-e", "s-a"}},
		{name: "one label", o: ListOptions{Labels: []string{"api"}}, want: []string{"s-a", "s-c"}},
		{name: "every label, any case", o: ListOptions{Labels: []string{"API", " x "}}, want: []string{"s-a"}},
		{name: "limit", o: ListOptions{Limit: 1}, want: []string{"s-e"}},
		{name: "filters combine", o: ListOptions{Repo: "r1", Labels: []string{"api"}, Status: StatusNeedsAttention}, want: []string{"s-c"}},
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
	s := e.create(CreateOptions{RepoID: "r1", Labels: []string{"api"}})
	for _, ref := range []string{"r1", "repo", e.wt} {
		got, err := e.m.List(e.ctx(), ListOptions{Repo: ref})
		if err != nil || len(got) != 1 || got[0].ID != s.ID {
			t.Errorf("List(repo %q) = %v, %v", ref, got, err)
		}
	}
	if got, err := e.m.List(e.ctx(), ListOptions{Labels: []string{"other"}}); err != nil || len(got) != 0 {
		t.Errorf("List(label other) = %v, %v", got, err)
	}
	for _, o := range []ListOptions{{Repo: "nope"}, {Workspace: "nope"}} {
		if _, err := e.m.List(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("List(%+v) err = %v, want ErrInvalidArgument", o, err)
		}
	}
	if got, err := e.m.List(e.ctx(), ListOptions{All: true, Repo: "nope"}); err != nil || len(got) != 1 {
		t.Errorf("List(all) = %v, %v", got, err)
	}
}
