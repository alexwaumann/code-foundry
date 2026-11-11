package thread

import "testing"

// DetailOf is the wake's detail (TestWakeDetailOf has its rules) as thread.get reads
// it: the pending request.
func TestDetailOf(t *testing.T) {
	tests := []struct {
		name      string
		t         Thread
		items     []Item
		pendingID string
	}{
		{name: "no request", t: Thread{Status: StatusIdle}, items: []Item{{Kind: KindUserMessage, Text: "do it"}}},
		{name: "a pending permission", t: Thread{Status: StatusNeedsAttention, StatusReason: "permission: Bash ls", PendingRequestID: "r1"},
			items:     []Item{{ID: "perm-r1", Kind: KindPermission, Request: &Request{RequestID: "r1", ToolName: "Bash", Description: "ls", State: RequestPending}}},
			pendingID: "r1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := DetailOf(tt.t, tt.items)
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
