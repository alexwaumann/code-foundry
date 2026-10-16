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
