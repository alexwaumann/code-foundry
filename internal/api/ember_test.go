package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/ember"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// emberFake is an EmberStore whose snapshot a test replaces (and publishes).
type emberFake struct {
	snap atomic.Pointer[ember.Snapshot]
	bus  *bus.Bus
}

func (f *emberFake) Snapshot() *ember.Snapshot { return f.snap.Load() }

func (f *emberFake) put(s *ember.Snapshot) {
	f.snap.Store(s)
	bus.Publish(f.bus, ember.Changed{Snapshot: s})
}

func newEmberServer(t *testing.T) (*emberFake, codefoundryv1connect.EmberServiceClient) {
	t.Helper()
	f := &emberFake{bus: bus.New()}
	f.snap.Store(emberFixture())
	route := NewEmber(f, f.bus).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return f, codefoundryv1connect.NewEmberServiceClient(srv.Client(), srv.URL)
}

var emberAt = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)

func emberFixture() *ember.Snapshot {
	return &ember.Snapshot{
		Status: ember.Status{Enabled: true, ThreadID: "s-e", Epoch: 3, EpochStartedAt: emberAt, ContextTokens: 1200, EpochContextTokens: 400000,
			Counts: ember.Counts{Todo: 1, Done: 1}},
		Tasks: []ember.Task{
			{ID: "t-00000001", Title: "Docs", State: ember.StateTodo, ThreadID: "s-w", CreatedAt: emberAt,
				Thread: &ember.TaskThread{ID: "s-w", Name: "Docs", State: thread.StateConnected, Status: thread.StatusBusy,
					Report: thread.Report{Status: thread.ReportBlocked, Summary: "needs a token", At: emberAt}}},
			{ID: "t-00000002", Title: "Old", State: ember.StateDone, DoneAt: emberAt, Outcome: "merged", Branch: "cf/old"},
		},
	}
}

func TestEmberService(t *testing.T) {
	f, c := newEmberServer(t)
	ctx := context.Background()
	st, err := c.GetStatus(ctx, connect.NewRequest(&v1.GetEmberStatusRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if s := st.Msg.GetStatus(); !s.GetEnabled() || s.GetThreadId() != "s-e" || s.GetEpoch() != 3 || !s.GetEpochStartedAt().AsTime().Equal(emberAt) ||
		s.GetCounts().GetTodo() != 1 || s.GetEpochContextTokens() != 400000 || s.GetLastConsolidatedAt() != nil {
		t.Errorf("status = %v", s)
	}
	all, err := c.ListTasks(ctx, connect.NewRequest(&v1.ListEmberTasksRequest{}))
	if err != nil || len(all.Msg.GetTasks()) != 2 {
		t.Fatalf("ListTasks = %v, %v", all, err)
	}
	tk := all.Msg.GetTasks()[0]
	if tk.GetState() != v1.EmberTaskState_EMBER_TASK_STATE_TODO || tk.GetThread().GetStatus() != v1.ThreadStatus_THREAD_STATUS_BUSY ||
		tk.GetThread().GetReportStatus() != v1.ThreadReportStatus_THREAD_REPORT_STATUS_BLOCKED || tk.GetThread().GetReportSummary() != "needs a token" ||
		tk.GetDoneAt() != nil {
		t.Errorf("task = %v", tk)
	}
	if done := all.Msg.GetTasks()[1]; done.GetState() != v1.EmberTaskState_EMBER_TASK_STATE_DONE || done.GetThread() != nil || done.GetDoneAt() == nil || done.GetBranch() != "cf/old" {
		t.Errorf("done task = %v", done)
	}
	open, err := c.ListTasks(ctx, connect.NewRequest(&v1.ListEmberTasksRequest{Open: true}))
	if err != nil || len(open.Msg.GetTasks()) != 1 || open.Msg.GetTasks()[0].GetId() != "t-00000001" {
		t.Errorf("open tasks = %v, %v", open, err)
	}

	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := c.WatchBoard(wctx, connect.NewRequest(&v1.WatchEmberBoardRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || len(stream.Msg().GetTasks()) != 2 {
		t.Fatalf("first board: %v, %v", stream.Msg(), stream.Err())
	}
	next := emberFixture()
	next.Tasks = next.Tasks[:1]
	next.Status.Consolidating = true
	f.put(next)
	if !stream.Receive() || len(stream.Msg().GetTasks()) != 1 || !stream.Msg().GetStatus().GetConsolidating() {
		t.Errorf("second board: %v, %v", stream.Msg(), stream.Err())
	}
}
