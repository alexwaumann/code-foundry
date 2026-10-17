package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// List without a filter answers every thread in creation order and the ledger; with
// one, the store's selection, newest activity first, and the ledger only for all.
func TestThreadListFilter(t *testing.T) {
	b := bus.New()
	fake := threadtest.New(b)
	t0 := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	fake.Put(thread.Thread{ID: "s-1", CreatedAt: t0, LastActivityAt: t0, Status: thread.StatusBusy, Labels: []string{"api"}})
	fake.Put(thread.Thread{ID: "s-2", CreatedAt: t0.Add(time.Minute), LastActivityAt: t0.Add(time.Hour), Status: thread.StatusIdle})
	fake.Put(thread.Thread{ID: "s-3", CreatedAt: t0.Add(2 * time.Minute), ArchivedAt: t0, Status: thread.StatusIdle})
	fake.SetRetiredUsage([]thread.UsageBucket{{Model: "claude-opus-5-5", Day: "2026-10-16", Requests: 1}})
	h := NewThread(fake, b)
	list := func(f *v1.ThreadFilter) ([]string, int) {
		t.Helper()
		res, err := h.List(context.Background(), connect.NewRequest(&v1.ListThreadsRequest{Filter: f}))
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for _, s := range res.Msg.GetThreads() {
			ids = append(ids, s.GetId())
		}
		return ids, len(res.Msg.GetRetiredUsage())
	}
	tests := []struct {
		name        string
		filter      *v1.ThreadFilter
		want        []string
		wantRetired int
	}{
		{name: "no filter", want: []string{"s-1", "s-2", "s-3"}, wantRetired: 1},
		{name: "empty filter", filter: &v1.ThreadFilter{}, want: []string{"s-2", "s-1"}},
		{name: "status", filter: &v1.ThreadFilter{Status: v1.ThreadStatus_THREAD_STATUS_IDLE}, want: []string{"s-2"}},
		{name: "archived", filter: &v1.ThreadFilter{IncludeArchived: true, Status: v1.ThreadStatus_THREAD_STATUS_IDLE}, want: []string{"s-2", "s-3"}},
		{name: "labels", filter: &v1.ThreadFilter{Labels: []string{"api"}}, want: []string{"s-1"}},
		{name: "all", filter: &v1.ThreadFilter{All: true, Limit: 2}, want: []string{"s-2", "s-3"}, wantRetired: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, retired := list(tt.filter)
			if !slices.Equal(got, tt.want) || retired != tt.wantRetired {
				t.Errorf("List = %v (retired %d), want %v (%d)", got, retired, tt.want, tt.wantRetired)
			}
		})
	}
}

func TestListOptionsFromProto(t *testing.T) {
	got := listOptionsFromProto(&v1.ThreadFilter{All: true, IncludeArchived: true, Status: v1.ThreadStatus_THREAD_STATUS_ERROR,
		State: v1.ThreadState_THREAD_STATE_CLOSING, Repo: "app", Workspace: "w", CreatedBy: "user", Labels: []string{"a"}, Limit: 3})
	want := thread.ListOptions{All: true, IncludeArchived: true, Status: thread.StatusError, State: thread.StateClosing,
		Repo: "app", Workspace: "w", CreatedBy: thread.CreatedByUser, Labels: []string{"a"}, Limit: 3}
	if got.All != want.All || got.IncludeArchived != want.IncludeArchived || got.Status != want.Status || got.State != want.State ||
		got.Repo != want.Repo || got.Workspace != want.Workspace || got.CreatedBy != want.CreatedBy ||
		!slices.Equal(got.Labels, want.Labels) || got.Limit != want.Limit {
		t.Errorf("listOptionsFromProto = %+v, want %+v", got, want)
	}
}

// Create with a request_id twice answers the first thread, reused.
func TestThreadCreateRequestID(t *testing.T) {
	b := bus.New()
	h := NewThread(threadtest.New(b), b)
	create := func() *v1.CreateThreadResponse {
		t.Helper()
		res, err := h.Create(context.Background(), connect.NewRequest(&v1.CreateThreadRequest{WorktreePath: "/wt", RequestId: "k1"}))
		if err != nil {
			t.Fatal(err)
		}
		return res.Msg
	}
	first, second := create(), create()
	if first.GetReused() || !second.GetReused() || first.GetThread().GetId() != second.GetThread().GetId() {
		t.Errorf("first %v, second %v", first, second)
	}
	_, err := h.Create(context.Background(), connect.NewRequest(&v1.CreateThreadRequest{WorktreePath: "/wt", RequestId: "a\x01b"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("a bad key: %v", err)
	}
}
