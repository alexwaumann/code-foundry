package daemon

import (
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadPlace(t *testing.T) {
	none := func(thread.Thread) []thread.Checkout { return nil }
	tests := []struct {
		name string
		t    thread.Thread
		want bool
	}{
		{"a placed thread", thread.Thread{ID: "t", ProjectID: "r1", WorktreePath: "/wt"}, true},
		{"a thread whose worktree is still being made", thread.Thread{ID: "t", ProjectID: "r1"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snap := &thread.Snapshot{Threads: []thread.Thread{tt.t}}
			if _, ok := threadPlace(snap, "t", none); ok != tt.want {
				t.Errorf("threadPlace ok = %v", ok)
			}
		})
	}
}
