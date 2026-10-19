package api

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A wait on a thread being removed does not take its closing snapshot for idle: it
// answers removed once the thread is gone, as does a wait, a get or a list after.
func TestThreadRemovedWaitGetList(t *testing.T) {
	fake, c := newThreadServer(t)
	report := thread.Report{Status: thread.ReportDone, Summary: "c6b0cb6", At: time.Unix(1_800_000_000, 0)}
	fake.Put(thread.Thread{ID: "s-c", Name: "child", CreatedBy: "s-p", Labels: []string{"e4"}, State: thread.StateConnected,
		Status: thread.StatusBusy, StatusReason: "working", Report: report})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	type answer struct {
		res *connect.Response[v1.WaitThreadResponse]
		err error
	}
	done := make(chan answer, 1)
	go func() {
		res, err := c.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{Id: "s-c"}))
		done <- answer{res, err}
	}()
	time.Sleep(20 * time.Millisecond)
	// Remove closes it first: idle at its prompt, closing, but being removed.
	fake.Put(thread.Thread{ID: "s-c", Name: "child", CreatedBy: "s-p", Labels: []string{"e4"}, State: thread.StateClosing,
		Status: thread.StatusIdle, StatusReason: "at prompt", Report: report, Removing: true})
	select {
	case a := <-done:
		t.Fatalf("the closing snapshot of a removal ended the wait: %v, %v", a.res, a.err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := fake.Remove(ctx, "s-c"); err != nil {
		t.Fatal(err)
	}
	check := func(what string, r *v1.RemovedThread) {
		t.Helper()
		if r.GetId() != "s-c" || r.GetName() != "child" || r.GetCreatedBy() != "s-p" || r.GetRemovedAt() == nil ||
			r.GetReportStatus() != v1.ThreadReportStatus_THREAD_REPORT_STATUS_DONE || r.GetReportSummary() != "c6b0cb6" {
			t.Errorf("%s: removed = %v", what, r)
		}
	}
	a := <-done
	if a.err != nil || a.res.Msg.GetThread() != nil {
		t.Fatalf("Wait = %v, %v; want removed", a.res, a.err)
	}
	check("wait during", a.res.Msg.GetRemoved())

	res, err := c.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{Id: "s-c"}))
	if err != nil {
		t.Fatal(err)
	}
	check("wait after", res.Msg.GetRemoved())

	_, err = c.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: "s-c"}))
	var ce *connect.Error
	if !errors.As(err, &ce) || ce.Code() != connect.CodeNotFound || len(ce.Details()) != 1 {
		t.Fatalf("Get = %v, want NOT_FOUND with a detail", err)
	}
	m, err := ce.Details()[0].Value()
	if r, ok := m.(*v1.RemovedThread); err != nil || !ok {
		t.Fatalf("detail = %v, %v", m, err)
	} else {
		check("get", r)
	}

	for _, tt := range []struct {
		name string
		f    *v1.ThreadFilter
		want int
	}{
		{"include removed, by the creator", &v1.ThreadFilter{IncludeRemoved: true, CreatedBy: "s-p"}, 1},
		{"include removed, another creator", &v1.ThreadFilter{IncludeRemoved: true, CreatedBy: "s-o"}, 0},
		{"not asked for", &v1.ThreadFilter{All: true}, 0},
	} {
		res, err := c.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: tt.f}))
		if err != nil || len(res.Msg.GetRemoved()) != tt.want {
			t.Errorf("%s: List = %v, %v; want %d removed", tt.name, res, err, tt.want)
		}
	}
	if _, err := c.Wait(ctx, connect.NewRequest(&v1.WaitThreadRequest{Id: "s-nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Wait on an unknown id = %v", err)
	}
}
