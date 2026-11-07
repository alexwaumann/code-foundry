package api

import (
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A wait ends early only for a question to the thread that waits, asked since it began.
func TestAskedOf(t *testing.T) {
	since := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	after, before := &thread.ThreadAsked{Question: "q", Assuming: "a", At: since.Add(time.Second)}, &thread.ThreadAsked{Question: "q", At: since.Add(-time.Second)}
	tests := []struct {
		name string
		t    thread.Thread
		by   string
		want bool
	}{
		{"its child asked", thread.Thread{ID: "s-2", CreatedBy: "s-1", Asked: after}, "s-1", true},
		{"asked before the wait", thread.Thread{ID: "s-2", CreatedBy: "s-1", Asked: before}, "s-1", false},
		{"someone else's child", thread.Thread{ID: "s-2", CreatedBy: "s-9", Asked: after}, "s-1", false},
		{"no waiter: a script's wait", thread.Thread{ID: "s-2", CreatedBy: "s-1", Asked: after}, "", false},
		{"nothing asked", thread.Thread{ID: "s-2", CreatedBy: "s-1"}, "s-1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := askedOf(tt.t, tt.by, since); (got != nil) != tt.want {
				t.Errorf("got %+v", got)
			}
		})
	}
}
