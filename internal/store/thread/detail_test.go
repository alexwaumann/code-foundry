package thread

import (
	"testing"
	"time"
)

// DetailOf is the wake's detail (TestWakeDetailOf has its rules) as thread.get and
// thread.reports read it: a stale report also while the thread works on the follow-up,
// never for a thread without a report, and the pending request.
func TestDetailOf(t *testing.T) {
	t0 := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	user := func(at time.Time) Item { return Item{Kind: KindUserMessage, Text: "do it", CreatedAt: at} }
	report := Report{Status: ReportDone, Summary: "did it", At: t0.Add(time.Minute)}
	tests := []struct {
		name      string
		t         Thread
		items     []Item
		stale     bool
		pendingID string
	}{
		{name: "report after the last message", t: Thread{Status: StatusIdle, Report: report}, items: []Item{user(t0)}},
		{name: "a follow-up after the report, still working", t: Thread{Status: StatusBusy, Report: report},
			items: []Item{user(t0), user(t0.Add(2 * time.Minute))}, stale: true},
		{name: "a subagent's message does not count", t: Thread{Status: StatusIdle, Report: report},
			items: []Item{user(t0), {Kind: KindUserMessage, CreatedAt: t0.Add(2 * time.Minute), ParentToolUseID: "tool-1"}}},
		{name: "no report is not stale", t: Thread{Status: StatusIdle}, items: []Item{user(t0)}},
		{name: "a pending permission", t: Thread{Status: StatusNeedsAttention, StatusReason: "permission: Bash ls", PendingRequestID: "r1"},
			items:     []Item{{ID: "perm-r1", Kind: KindPermission, Request: &Request{RequestID: "r1", ToolName: "Bash", Description: "ls", State: RequestPending}}},
			pendingID: "r1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := DetailOf(tt.t, tt.items)
			if d.ReportStale != tt.stale {
				t.Errorf("ReportStale = %v, want %v", d.ReportStale, tt.stale)
			}
			got := ""
			if d.Pending != nil {
				got = d.Pending.RequestID
			}
			if got != tt.pendingID {
				t.Errorf("pending = %q, want %q", got, tt.pendingID)
			}
		})
	}
}
