package command

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestOnTurn(t *testing.T) {
	tests := []struct {
		status v1.ThreadStatus
		reason string
		want   bool
	}{
		{v1.ThreadStatus_THREAD_STATUS_BUSY, "working", true},
		{v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "permission: Bash git push", true},
		{v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "question: Which color?", true},
		{v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "finished", false},
		{v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, "error: overloaded", false},
		{v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt", false},
	}
	for _, tt := range tests {
		if got := onTurn(&v1.Thread{Status: tt.status, StatusReason: tt.reason}); got != tt.want {
			t.Errorf("onTurn(%v, %q) = %v, want %v", tt.status, tt.reason, got, tt.want)
		}
	}
}

// thread.respond's tail names what still waits on an answer (w2a finding 2).
func TestStillPending(t *testing.T) {
	bash := &v1.ThreadPendingRequest{RequestId: "r2", ToolName: "Bash", Summary: "Bash Remove docs"}
	q := &v1.ThreadPendingRequest{RequestId: "r3", Question: true, Summary: "Which color?"}
	bare := &v1.ThreadPendingRequest{RequestId: "r4"}
	tests := []struct {
		name    string
		pending []*v1.ThreadPendingRequest
		want    string
	}{
		{"none", nil, "nothing pending"},
		{"only the answered one, not yet withdrawn", []*v1.ThreadPendingRequest{{RequestId: "r1"}}, "nothing pending"},
		{"one more", []*v1.ThreadPendingRequest{{RequestId: "r1"}, bash}, "1 more pending: permission: Bash Remove docs (request r2)"},
		{"a question and one without a summary", []*v1.ThreadPendingRequest{q, bare}, "2 more pending: question: Which color? (request r3) | permission (request r4)"},
	}
	for _, tt := range tests {
		if got := stillPending(tt.pending, "r1"); got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}
