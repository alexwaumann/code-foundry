package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The quick terminal across a snooze through the service: snooze_thread's quick_ran is the
// line the window shows (QuickTerminal.ran), opening the thread names it in
// fresh_quick_thread_id, and set_quick's forget_ran drops the line.
func TestLayoutQuickTerminalAcrossASnooze(t *testing.T) {
	_, cl, _ := layoutServer(t)
	ctx := context.Background()
	must := func(op *v1.LayoutOp) *v1.ApplyLayoutResponse {
		t.Helper()
		res, err := applyLayout(ctx, cl, op)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	quick := func() *v1.QuickTerminal {
		t.Helper()
		got, err := cl.Get(ctx, connect.NewRequest(&v1.GetLayoutRequest{}))
		if err != nil {
			t.Fatal(err)
		}
		for _, th := range got.Msg.GetLayout().GetThreads() {
			if th.GetThreadId() == "s-1" {
				return th.GetQuick()
			}
		}
		return nil
	}
	must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-1", Focus: true}}})
	must(&v1.LayoutOp{Op: &v1.LayoutOp_SetQuick{SetQuick: &v1.SetQuickOp{ThreadId: "s-1", Open: true}}})
	must(&v1.LayoutOp{Op: &v1.LayoutOp_SnoozeThread{SnoozeThread: &v1.SnoozeThreadOp{ThreadId: "s-1", QuickRan: "make dev"}}})
	if q := quick(); q.GetOpen() || q.GetRan() != "make dev" {
		t.Fatalf("after the snooze: %v", q)
	}
	res := must(&v1.LayoutOp{Op: &v1.LayoutOp_OpenThread{OpenThread: &v1.OpenThreadOp{ThreadId: "s-1", Focus: true}}})
	if res.GetFreshQuickThreadId() != "s-1" {
		t.Errorf("open_thread = %v, want fresh_quick_thread_id s-1", res)
	}
	if q := quick(); !q.GetOpen() || q.GetRan() != "make dev" {
		t.Errorf("after opening: %v", q)
	}
	must(&v1.LayoutOp{Op: &v1.LayoutOp_SetQuick{SetQuick: &v1.SetQuickOp{ThreadId: "s-1", Open: true, ForgetRan: true}}})
	if q := quick(); !q.GetOpen() || q.GetRan() != "" {
		t.Errorf("after forget_ran: %v", q)
	}
}
