package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

type countContexts struct{ n atomic.Int32 }

func (c *countContexts) ContextsChanged() { c.n.Add(1) }

func TestPluginContextsFollowThreadsAndProjects(t *testing.T) {
	b := bus.New()
	c := &countContexts{}
	stop := startPluginContexts(context.Background(), b, c)
	defer stop()
	tests := []struct {
		name    string
		publish func()
		counts  bool
	}{
		{"thread updated", func() { bus.Publish[thread.Event](b, thread.Updated{}) }, true},
		{"thread removed", func() { bus.Publish[thread.Event](b, thread.Removed{ID: "s-1"}) }, true},
		{"retired usage", func() { bus.Publish[thread.Event](b, thread.RetiredUsage{}) }, false},
		{"project removed", func() { bus.Publish[project.Event](b, project.ProjectRemoved{ID: "p"}) }, true},
		{"worktree updated", func() { bus.Publish[project.Event](b, project.WorktreeUpdated{}) }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := c.n.Load()
			tt.publish()
			// A marker that always counts, so the event before it has been handled.
			bus.Publish[thread.Event](b, thread.Removed{ID: "marker"})
			deadline := time.Now().Add(5 * time.Second)
			want := before + 1
			if tt.counts {
				want++
			}
			for c.n.Load() < want && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if got := c.n.Load(); got != want {
				t.Errorf("calls %d, want %d", got-before, want-before)
			}
		})
	}
}
