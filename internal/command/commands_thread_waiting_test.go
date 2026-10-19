package command

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestThreadStatusWordWaiting(t *testing.T) {
	idle, attention := v1.ThreadStatus_THREAD_STATUS_IDLE, v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION
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
	}
	for _, tt := range tests {
		if got := threadStatusWord(&v1.Thread{Status: tt.status, StatusReason: tt.reason}); got != tt.want {
			t.Errorf("threadStatusWord(%v, %q) = %q; want %q", tt.status, tt.reason, got, tt.want)
		}
	}
}
