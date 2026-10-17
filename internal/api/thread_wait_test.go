package api

import (
	"testing"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

func TestThreadWaitMet(t *testing.T) {
	const (
		idle  = v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_IDLE
		unset = v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_UNSPECIFIED
		attn  = v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ATTENTION
		fail  = v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_ERROR
		disc  = v1.ThreadWaitCondition_THREAD_WAIT_CONDITION_DISCONNECTED

		starting  = v1.ThreadState_THREAD_STATE_STARTING
		connected = v1.ThreadState_THREAD_STATE_CONNECTED
		closing   = v1.ThreadState_THREAD_STATE_CLOSING
		stopped   = v1.ThreadState_THREAD_STATE_DISCONNECTED

		unknown  = v1.ThreadStatus_THREAD_STATUS_UNSPECIFIED
		busy     = v1.ThreadStatus_THREAD_STATUS_BUSY
		atPrompt = v1.ThreadStatus_THREAD_STATUS_IDLE
		needs    = v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION
		failed   = v1.ThreadStatus_THREAD_STATUS_ERROR
	)
	tests := []struct {
		name   string
		until  v1.ThreadWaitCondition
		state  v1.ThreadState
		status v1.ThreadStatus
		reason string
		want   bool
	}{
		{"idle at prompt", idle, connected, atPrompt, "at prompt", true},
		{"unset means idle", unset, connected, atPrompt, "at prompt", true},
		{"idle while closing", idle, closing, atPrompt, "at prompt", true},
		{"idle stopped", idle, stopped, atPrompt, "at prompt", true},
		{"starting is not idle", idle, starting, unknown, "starting", false},
		{"starting for a message", idle, starting, busy, "working", false},
		{"busy", idle, connected, busy, "working", false},
		{"compacting", idle, connected, busy, "compacting", false},
		{"unseen finished turn", idle, connected, needs, "finished", true},
		{"unseen failed turn", idle, connected, needs, "error: rate_limit", true},
		{"snooze ended", idle, stopped, needs, "snooze ended", true},
		{"permission prompt", idle, connected, needs, "permission: Bash ls", false},
		{"question", idle, connected, needs, "question: Which color?", false},
		{"interrupted counts as idle", idle, stopped, failed, "interrupted", true},
		{"old row without status, stopped", idle, stopped, unknown, "", true},
		{"old row without status, connected", idle, connected, unknown, "", false},
		{"attention: permission", attn, connected, needs, "permission: Bash ls", true},
		{"attention: finished", attn, connected, needs, "finished", true},
		{"attention: idle", attn, connected, atPrompt, "at prompt", false},
		{"error", fail, stopped, failed, "did not start", true},
		{"error: a turn's API error is attention", fail, connected, needs, "error: overloaded", false},
		{"disconnected", disc, stopped, atPrompt, "at prompt", true},
		{"closing is not disconnected", disc, closing, atPrompt, "at prompt", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := &v1.Thread{Id: "s1", State: tt.state, Status: tt.status, StatusReason: tt.reason}
			if got := threadWaitMet(tt.until, th); got != tt.want {
				t.Errorf("threadWaitMet(%s, %s %s %q) = %v, want %v", tt.until, tt.state, tt.status, tt.reason, got, tt.want)
			}
		})
	}
}
