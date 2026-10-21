package command

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestThreadStatusWordWaiting(t *testing.T) {
	idle, attention, failed := v1.ThreadStatus_THREAD_STATUS_IDLE, v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, v1.ThreadStatus_THREAD_STATUS_ERROR
	tests := []struct {
		status v1.ThreadStatus
		reason string
		want   string
	}{
		{idle, "waiting on 2 child threads", "waiting (on 2 children)"},
		{idle, "waiting on 1 child thread", "waiting (on 1 child)"},
		{idle, "waiting", "waiting"},
		{idle, "at prompt", "idle"},
		{idle, "", "idle"},
		{attention, "finished", "attention (finished)"},
		{failed, "interrupted", "error (interrupted)"},
		{failed, "crashed", "error (crashed)"},
	}
	for _, tt := range tests {
		if got := threadStatusWord(&v1.Thread{Status: tt.status, StatusReason: tt.reason}); got != tt.want {
			t.Errorf("threadStatusWord(%v, %q) = %q; want %q", tt.status, tt.reason, got, tt.want)
		}
	}
}

// A thread whose Claude has not reported a status yet is starting, not "unknown".
func TestNoStatusWord(t *testing.T) {
	starting := &v1.Thread{State: v1.ThreadState_THREAD_STATE_STARTING}
	stopped := &v1.Thread{State: v1.ThreadState_THREAD_STATE_DISCONNECTED}
	for _, tt := range []struct {
		name, got, want string
	}{
		{"list", threadStatusWord(starting), "starting"},
		{"wait", waitStatus(starting), "starting"},
		{"reports", threadStatusName(starting), "starting"},
		{"list, no process", threadStatusWord(stopped), "not started"},
		{"wait, no process", waitStatus(stopped), "not started"},
	} {
		if tt.got != tt.want {
			t.Errorf("%s: %q, want %q", tt.name, tt.got, tt.want)
		}
	}
}
