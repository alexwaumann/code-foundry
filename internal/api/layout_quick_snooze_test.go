package api

import (
	"context"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The quick terminal across a snooze through the service (docs/notes/snooze-without-teardown.md):
// snooze_thread leaves it as it is (open, no "Run again" line: its shell runs on), and the
// thread waking (set_snoozed) puts its tab back with it, asking for no fresh shell.
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
	if q := quick(); !q.GetOpen() || q.GetRan() != "" {
		t.Fatalf("after the snooze: %v, want it open with no Run again line", q)
	}
	res := must(&v1.LayoutOp{Op: &v1.LayoutOp_SetSnoozed{SetSnoozed: &v1.SetSnoozedOp{ThreadId: "s-1"}}})
	if res.GetFreshQuickThreadId() != "" || res.GetTabId() == "" {
		t.Errorf("set_snoozed = %v, want the thread's tab back and no fresh_quick_thread_id", res)
	}
	if q := quick(); !q.GetOpen() || q.GetRan() != "" {
		t.Errorf("after the wake: %v", q)
	}
}
